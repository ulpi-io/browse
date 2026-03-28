# Search & Vector — tantivy FTS, HNSW Vectors, SIMD Distance, Hybrid Search

## What

Full-text search via tantivy, approximate nearest-neighbor vector search via HNSW, SIMD-accelerated distance functions, and hybrid search combining BM25 + vector scores. This reference covers the complete implementation path from index creation through query execution for both modalities, plus the embedding pipeline that feeds vectors into the system.

### Key Dependencies

| Crate | Purpose |
|---|---|
| `tantivy` | Full-text search engine (BM25, tokenizers, segment merging) |
| `memmap2` | Memory-mapped vector storage for zero-copy SIMD reads |
| `std::arch` | SIMD intrinsics (AVX2, SSE4.1, NEON) |
| `candle-core` | Local embedding model inference (tensors, GPU) |
| `candle-transformers` | Pre-built transformer architectures (BERT, e5, etc.) |
| `reqwest` | Remote embedding API calls (OpenAI-compatible) |

---

## Full-Text Search with tantivy

### Schema and Index Setup

```rust
use tantivy::schema::*;
use tantivy::{Index, IndexWriter, TantivyDocument};

/// Build a tantivy schema for a document collection.
/// TEXT fields are tokenized and searchable. STORED fields are returned in results.
/// STRING fields are indexed verbatim (exact match only — no tokenization).
/// FAST fields support aggregation and sorting (column-oriented storage).
fn build_schema() -> Schema {
    let mut builder = Schema::builder();

    // Full-text searchable, stored for retrieval, positional data for phrase queries
    let text_options = TextOptions::default()
        .set_indexing_options(
            TextFieldIndexing::default()
                .set_tokenizer("en_stem")
                .set_index_option(IndexRecordOption::WithFreqsAndPositions),
        )
        .set_stored();

    builder.add_text_field("title", text_options.clone());
    builder.add_text_field("body", text_options);

    // Exact-match field — not tokenized. Use for IDs, enum values, tags.
    builder.add_text_field("doc_id", STRING | STORED);

    // Fast field — columnar storage for sorting, range queries, facets.
    builder.add_u64_field("created_at", INDEXED | STORED | FAST);
    builder.add_f64_field("boost_score", FAST);

    // Facet field — hierarchical categorization (e.g., "/lang/rust/async")
    builder.add_facet_field("category", FacetOptions::default());

    // Bytes field — opaque binary payload, stored but not indexed
    builder.add_bytes_field("embedding_raw", STORED);

    builder.build()
}

/// Create or open a tantivy index on disk.
fn open_or_create_index(
    path: &std::path::Path,
    schema: &Schema,
) -> tantivy::Result<Index> {
    let dir = tantivy::directory::MmapDirectory::open(path)?;
    Index::open_or_create(dir, schema.clone())
}
```

**Field type decision tree:**

```
Need full-text search (tokenized)?
  YES → TEXT + set_indexing_options with tokenizer
  NO → exact match needed?
    YES → STRING (verbatim, no tokenization)
    NO → numeric/date/sort?
      YES → u64/i64/f64/date with FAST
      NO → hierarchical taxonomy?
        YES → FACET
        NO → BYTES (opaque storage)
```

### Writing Documents

The write path: validate input, build tantivy document, add to IndexWriter, commit. IndexWriter holds a WAL internally; `commit()` flushes to segments on disk.

```rust
use tantivy::{Index, IndexWriter, TantivyDocument};

/// Index writer with configurable memory budget.
/// The heap_size controls how much RAM tantivy uses before flushing a segment.
/// 50 MB is reasonable for most workloads. Increase for bulk imports.
fn create_writer(index: &Index, heap_size_bytes: usize) -> tantivy::Result<IndexWriter> {
    index.writer(heap_size_bytes)
}

/// Write a single document. Does NOT commit — caller batches and commits.
fn index_document(
    writer: &IndexWriter,
    schema: &Schema,
    doc_id: &str,
    title: &str,
    body: &str,
    created_at: u64,
    category: &str,
) -> tantivy::Result<()> {
    let doc_id_field = schema.get_field("doc_id").unwrap();
    let title_field = schema.get_field("title").unwrap();
    let body_field = schema.get_field("body").unwrap();
    let created_at_field = schema.get_field("created_at").unwrap();
    let category_field = schema.get_field("category").unwrap();

    let mut doc = TantivyDocument::new();
    doc.add_text(doc_id_field, doc_id);
    doc.add_text(title_field, title);
    doc.add_text(body_field, body);
    doc.add_u64(created_at_field, created_at);
    doc.add_facet(category_field, Facet::from(category));

    writer.add_document(doc)?;
    Ok(())
}

/// Commit flushes buffered documents to a new segment on disk.
/// Call after a batch of writes. Each commit creates one segment;
/// tantivy merges segments in the background.
fn commit_batch(writer: &mut IndexWriter) -> tantivy::Result<()> {
    writer.commit()?;
    Ok(())
}

/// Bulk import pattern: batch N documents between commits.
/// Avoids creating too many small segments.
fn bulk_index(
    writer: &mut IndexWriter,
    schema: &Schema,
    documents: impl Iterator<Item = DocumentInput>,
    batch_size: usize,
) -> tantivy::Result<u64> {
    let mut count = 0u64;
    for doc_input in documents {
        index_document(
            writer, schema,
            &doc_input.id, &doc_input.title, &doc_input.body,
            doc_input.created_at, &doc_input.category,
        )?;
        count += 1;
        if count % batch_size as u64 == 0 {
            writer.commit()?;
        }
    }
    // Final commit for remaining documents
    writer.commit()?;
    Ok(count)
}
```

**Async vs sync indexing:** tantivy's `IndexWriter` is not `Send`. For async systems, run indexing on a dedicated thread and communicate via channels:

```rust
use tokio::sync::mpsc;

enum IndexCommand {
    AddDocument(DocumentInput),
    Commit,
    Shutdown,
}

/// Spawn a dedicated indexing thread. Send commands via the channel.
/// The writer lives on this thread — never crosses async boundaries.
fn spawn_index_thread(
    index: Index,
    schema: Schema,
    heap_size: usize,
) -> mpsc::Sender<IndexCommand> {
    let (tx, mut rx) = mpsc::channel::<IndexCommand>(10_000);

    std::thread::spawn(move || {
        let mut writer = index.writer(heap_size).expect("failed to create writer");
        while let Some(cmd) = rx.blocking_recv() {
            match cmd {
                IndexCommand::AddDocument(input) => {
                    let _ = index_document(
                        &writer, &schema,
                        &input.id, &input.title, &input.body,
                        input.created_at, &input.category,
                    );
                }
                IndexCommand::Commit => {
                    let _ = writer.commit();
                }
                IndexCommand::Shutdown => {
                    let _ = writer.commit();
                    break;
                }
            }
        }
    });

    tx
}
```

### Searching

Obtain a `Searcher` from a reader. The reader provides a consistent snapshot; new segments become visible after `reload()`.

```rust
use tantivy::collector::TopDocs;
use tantivy::query::{
    BooleanQuery, FuzzyTermQuery, Occur, PhraseQuery, QueryParser, TermQuery,
};
use tantivy::{Index, ReloadPolicy, Score, Term};

/// Create a reader with near-real-time reload. The reader polls for new
/// segments on a background thread. Manual reload: reader.reload().
fn create_reader(index: &Index) -> tantivy::Result<tantivy::IndexReader> {
    index
        .reader_builder()
        .reload_policy(ReloadPolicy::OnCommitWithDelay)
        .try_into()
}
```

#### BM25 Ranked Query (default)

```rust
/// Simple multi-field BM25 query. Returns (score, doc_address) pairs.
fn search_bm25(
    index: &Index,
    reader: &tantivy::IndexReader,
    schema: &Schema,
    query_text: &str,
    limit: usize,
) -> tantivy::Result<Vec<(Score, TantivyDocument)>> {
    let searcher = reader.searcher();

    let title_field = schema.get_field("title").unwrap();
    let body_field = schema.get_field("body").unwrap();

    // QueryParser searches both fields. Title matches are boosted 2x.
    let mut parser = QueryParser::for_index(index, vec![title_field, body_field]);
    parser.set_field_boost(title_field, 2.0);

    let query = parser.parse_query(query_text)?;
    let top_docs = searcher.search(&query, &TopDocs::with_limit(limit))?;

    let mut results = Vec::with_capacity(top_docs.len());
    for (score, doc_address) in top_docs {
        let doc: TantivyDocument = searcher.doc(doc_address)?;
        results.push((score, doc));
    }

    Ok(results)
}
```

#### Phrase Query

```rust
/// Exact phrase match — words must appear adjacent and in order.
fn search_phrase(
    searcher: &tantivy::Searcher,
    field: Field,
    words: &[&str],
    limit: usize,
) -> tantivy::Result<Vec<(Score, tantivy::DocAddress)>> {
    let terms: Vec<Term> = words
        .iter()
        .map(|w| Term::from_field_text(field, w))
        .collect();

    let query = PhraseQuery::new(terms);
    searcher.search(&query, &TopDocs::with_limit(limit))
}
```

#### Fuzzy Matching

```rust
/// Fuzzy term query — allows edit-distance tolerance for typos.
/// distance=1 catches single-char typos; distance=2 for more tolerance.
fn search_fuzzy(
    searcher: &tantivy::Searcher,
    field: Field,
    term_text: &str,
    distance: u8,
    limit: usize,
) -> tantivy::Result<Vec<(Score, tantivy::DocAddress)>> {
    let term = Term::from_field_text(field, term_text);
    let query = FuzzyTermQuery::new(term, distance, true); // true = prefix match
    searcher.search(&query, &TopDocs::with_limit(limit))
}
```

#### Boolean Queries (AND, OR, NOT)

```rust
/// Compose sub-queries with boolean logic.
/// Occur::Must = AND, Occur::Should = OR, Occur::MustNot = NOT.
fn search_boolean(
    searcher: &tantivy::Searcher,
    schema: &Schema,
    must_match: &str,
    should_match: &str,
    exclude: &str,
    limit: usize,
) -> tantivy::Result<Vec<(Score, tantivy::DocAddress)>> {
    let title = schema.get_field("title").unwrap();
    let body = schema.get_field("body").unwrap();

    let must_query = TermQuery::new(
        Term::from_field_text(body, must_match),
        IndexRecordOption::WithFreqs,
    );
    let should_query = TermQuery::new(
        Term::from_field_text(title, should_match),
        IndexRecordOption::WithFreqs,
    );
    let must_not_query = TermQuery::new(
        Term::from_field_text(body, exclude),
        IndexRecordOption::WithFreqs,
    );

    let query = BooleanQuery::new(vec![
        (Occur::Must, Box::new(must_query)),
        (Occur::Should, Box::new(should_query)),
        (Occur::MustNot, Box::new(must_not_query)),
    ]);

    searcher.search(&query, &TopDocs::with_limit(limit))
}
```

#### Faceted Search

```rust
use tantivy::collector::FacetCollector;

/// Count documents per category facet under a given prefix.
fn facet_counts(
    searcher: &tantivy::Searcher,
    schema: &Schema,
    facet_prefix: &str,
) -> tantivy::Result<Vec<(String, u64)>> {
    let category_field = schema.get_field("category").unwrap();

    let mut collector = FacetCollector::for_field("category");
    collector.add_facet(Facet::from(facet_prefix));

    let counts = searcher.search(&tantivy::query::AllQuery, &collector)?;
    let facet_counts: Vec<(String, u64)> = counts
        .get(facet_prefix)
        .map(|(facet, count)| (facet.to_string(), count))
        .collect();

    Ok(facet_counts)
}
```

### Custom Tokenizers

tantivy ships with basic tokenizers. Register custom ones on the index for multi-language support, stemming, stop words, and synonyms.

```rust
use tantivy::tokenizer::*;

/// Register custom tokenizers on the index. Call once after index creation.
fn register_tokenizers(index: &Index) {
    let tokenizer_manager = index.tokenizers();

    // English stemming + lowercase + stop words
    tokenizer_manager.register(
        "en_stem",
        TextAnalyzer::builder(SimpleTokenizer::default())
            .filter(RemoveLongFilter::limit(40))
            .filter(LowerCaser)
            .filter(StopWordFilter::remove(vec![
                "the".to_string(), "a".to_string(), "an".to_string(),
                "is".to_string(), "are".to_string(), "was".to_string(),
                "were".to_string(), "be".to_string(), "been".to_string(),
                "being".to_string(), "have".to_string(), "has".to_string(),
                "had".to_string(), "do".to_string(), "does".to_string(),
                "did".to_string(), "will".to_string(), "would".to_string(),
                "could".to_string(), "should".to_string(),
            ]))
            .filter(Stemmer::new(Language::English))
            .build(),
    );

    // CJK: bi-gram tokenizer for Chinese/Japanese/Korean text.
    // Each pair of adjacent characters becomes a token.
    tokenizer_manager.register(
        "cjk_bigram",
        TextAnalyzer::builder(SimpleTokenizer::default())
            .filter(LowerCaser)
            .filter(RemoveLongFilter::limit(40))
            .build(),
    );

    // Exact lowercase — for tag fields that need case-insensitive exact match
    tokenizer_manager.register(
        "exact_lower",
        TextAnalyzer::builder(RawTokenizer::default())
            .filter(LowerCaser)
            .build(),
    );
}

/// For multi-language support, detect the language at index time and store
/// a language tag. Use different tokenizers per field or per document variant.
///
/// Pattern: index the same text into multiple fields with different tokenizers:
///   - "body_en" with en_stem tokenizer
///   - "body_cjk" with cjk_bigram tokenizer
/// At query time, boost the field matching the detected query language.
```

### Index Lifecycle

```rust
/// Segment merging: tantivy merges small segments into larger ones in the
/// background. Control the merge policy for write-heavy vs read-heavy workloads.
fn configure_merge_policy(index: &Index) {
    // LogMergePolicy is the default. Merges segments when their sizes are
    // within a factor of each other. Good for general workloads.
    //
    // For write-heavy workloads (bulk import), increase min_merge_size
    // to reduce merge frequency during ingestion, then force-merge after:
    let mut writer = index.writer(100_000_000).unwrap();
    // After bulk import, merge down to fewer segments for faster reads
    writer.merge(&index.searchable_segment_ids().unwrap()).unwrap();
    writer.commit().unwrap();
}

/// Near-real-time search: new documents become searchable after commit + reload.
/// With ReloadPolicy::OnCommitWithDelay, the reader auto-reloads within ~500ms.
/// For immediate visibility, call reader.reload() explicitly after commit.
fn refresh_reader(reader: &tantivy::IndexReader) -> tantivy::Result<()> {
    reader.reload()
}
```

**Memory efficiency:** tantivy mmap's index segments by default when using `MmapDirectory`. The OS page cache handles eviction. No manual memory management needed for the search index itself.

---

## Vector Search with HNSW

### HNSW Data Structure

Hierarchical Navigable Small World: a multi-layer graph where each layer is a sparse navigable network. Upper layers have fewer nodes (skip-list-like) for fast coarse navigation; the bottom layer (layer 0) contains all nodes for precise search.

```rust
use std::collections::BinaryHeap;
use std::cmp::Reverse;

/// Distance function selector. All functions return a distance (lower = more similar).
/// Cosine distance = 1 - cosine_similarity.
#[derive(Debug, Clone, Copy)]
pub enum DistanceFunction {
    Cosine,
    L2,          // Euclidean
    DotProduct,  // Negative dot product (so lower = more similar)
    Manhattan,
}

/// Top-level HNSW index. Owns the graph structure and configuration.
pub struct HnswIndex {
    /// layers[0] is the bottom (densest) layer. layers[max_level] is the top.
    layers: Vec<HnswLayer>,
    /// Node index of the current entry point (always in the top layer).
    entry_point: Option<u32>,
    /// Maximum layer level currently in the graph.
    max_level: usize,
    /// Max connections per node on layers > 0.
    m: usize,
    /// Max connections per node on layer 0 (typically 2*m).
    m0: usize,
    /// Beam width during construction — higher = better recall, slower build.
    ef_construction: usize,
    /// Which distance metric to use.
    distance_fn: DistanceFunction,
    /// Normalization factor for level generation: 1 / ln(m).
    level_mult: f64,
    /// Total number of vectors in the index.
    num_vectors: u32,
}

struct HnswLayer {
    /// Adjacency list per node. neighbors[node_id] = sorted vec of neighbor IDs.
    neighbors: Vec<Vec<u32>>,
}

/// A candidate during search: (distance, node_id). Ordered by distance ascending.
#[derive(Debug, Clone, PartialEq)]
struct Candidate {
    distance: f32,
    id: u32,
}

impl Eq for Candidate {}

impl PartialOrd for Candidate {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        self.distance.partial_cmp(&other.distance)
    }
}

impl Ord for Candidate {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.distance.partial_cmp(&other.distance).unwrap_or(std::cmp::Ordering::Equal)
    }
}
```

### Vector Storage — mmap'd Contiguous Layout

Vectors stored contiguously in a flat file. Each vector is `dim * 4` bytes (f32). mmap provides zero-copy access; SIMD reads directly from memory-mapped pages.

```rust
use memmap2::{Mmap, MmapOptions};
use std::fs::File;

/// Contiguous vector storage backed by mmap.
/// Layout: [v0_f32_0, v0_f32_1, ..., v0_f32_{dim-1}, v1_f32_0, ...]
/// Vector i starts at byte offset i * dim * 4.
pub struct VectorStorage {
    mmap: Mmap,
    dim: usize,
    num_vectors: u32,
}

impl VectorStorage {
    /// Open an existing vector file. The file must contain num_vectors * dim * 4 bytes.
    pub fn open(path: &std::path::Path, dim: usize) -> std::io::Result<Self> {
        let file = File::open(path)?;
        let file_len = file.metadata()?.len() as usize;
        let num_vectors = (file_len / (dim * std::mem::size_of::<f32>())) as u32;

        // SAFETY: The file is opened read-only. The mmap is valid for the
        // lifetime of this struct. We never write through this mapping.
        let mmap = unsafe { MmapOptions::new().map(&file)? };

        Ok(Self { mmap, dim, num_vectors })
    }

    /// Get a slice of f32 values for vector at the given index.
    /// Zero-copy: returns a reference directly into the mmap'd region.
    #[inline]
    pub fn get_vector(&self, id: u32) -> &[f32] {
        let offset = id as usize * self.dim;
        // SAFETY: We verified file size in open(). The pointer is aligned
        // because the file is f32-contiguous and mmap alignment >= 4.
        unsafe {
            std::slice::from_raw_parts(
                self.mmap.as_ptr().add(offset * 4) as *const f32,
                self.dim,
            )
        }
    }

    /// Append a vector to the storage file. Used during index building.
    pub fn append(path: &std::path::Path, vector: &[f32]) -> std::io::Result<()> {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)?;
        let bytes: &[u8] = unsafe {
            std::slice::from_raw_parts(
                vector.as_ptr() as *const u8,
                vector.len() * std::mem::size_of::<f32>(),
            )
        };
        file.write_all(bytes)?;
        Ok(())
    }

    pub fn dim(&self) -> usize { self.dim }
    pub fn len(&self) -> u32 { self.num_vectors }
}
```

### Insert Algorithm

HNSW insert: randomly assign a level (exponential decay), search from the entry point down through layers to find neighbors, then connect the new node at each layer from its assigned level down to layer 0.

```rust
use rand::Rng;

impl HnswIndex {
    /// Create a new empty HNSW index.
    pub fn new(m: usize, ef_construction: usize, distance_fn: DistanceFunction) -> Self {
        Self {
            layers: vec![HnswLayer { neighbors: Vec::new() }],
            entry_point: None,
            max_level: 0,
            m,
            m0: m * 2,
            ef_construction,
            distance_fn,
            level_mult: 1.0 / (m as f64).ln(),
            num_vectors: 0,
        }
    }

    /// Randomly select a level for a new node. Higher levels are exponentially
    /// less likely. Returns 0 most of the time; the probability of level L is
    /// roughly (1/m)^L. This creates the skip-list-like hierarchy.
    fn random_level(&self) -> usize {
        let mut rng = rand::thread_rng();
        let r: f64 = rng.gen();
        (-r.ln() * self.level_mult).floor() as usize
    }

    /// Insert a vector into the HNSW index.
    /// `id` is the vector's index in VectorStorage.
    /// `vectors` provides access to all stored vectors for distance computation.
    pub fn insert(&mut self, id: u32, vectors: &VectorStorage) {
        let new_level = self.random_level();
        let query = vectors.get_vector(id);

        // Ensure we have enough layers
        while self.layers.len() <= new_level {
            self.layers.push(HnswLayer { neighbors: Vec::new() });
        }

        // Ensure each layer has a slot for this node
        for layer in &mut self.layers {
            while layer.neighbors.len() <= id as usize {
                layer.neighbors.push(Vec::new());
            }
        }

        // First insertion: set as entry point and return
        if self.entry_point.is_none() {
            self.entry_point = Some(id);
            self.max_level = new_level;
            self.num_vectors = 1;
            return;
        }

        let mut current_ep = self.entry_point.unwrap();

        // Phase 1: Greedily traverse layers above the insertion level.
        // At each layer, walk to the nearest neighbor — no connections made.
        for level in (new_level + 1..=self.max_level).rev() {
            current_ep = self.greedy_closest(
                query, current_ep, level, vectors,
            );
        }

        // Phase 2: At each layer from min(new_level, max_level) down to 0,
        // search with ef_construction beam width, then connect to the best neighbors.
        let start_level = new_level.min(self.max_level);
        for level in (0..=start_level).rev() {
            let max_connections = if level == 0 { self.m0 } else { self.m };

            // Beam search to find ef_construction nearest neighbors at this layer
            let neighbors = self.search_layer(
                query, current_ep, self.ef_construction, level, vectors,
            );

            // Select the best M neighbors (simple heuristic: closest by distance)
            let selected: Vec<u32> = neighbors
                .iter()
                .take(max_connections)
                .map(|c| c.id)
                .collect();

            // Bidirectional connections
            self.layers[level].neighbors[id as usize] = selected.clone();
            for &neighbor_id in &selected {
                let neighbor_list = &mut self.layers[level].neighbors[neighbor_id as usize];
                neighbor_list.push(id);

                // Prune if over capacity: keep only the closest max_connections neighbors
                if neighbor_list.len() > max_connections {
                    self.prune_connections(neighbor_id, max_connections, level, vectors);
                }
            }

            if !neighbors.is_empty() {
                current_ep = neighbors[0].id;
            }
        }

        // Update entry point if the new node is at a higher level
        if new_level > self.max_level {
            self.entry_point = Some(id);
            self.max_level = new_level;
        }

        self.num_vectors += 1;
    }

    /// Greedy walk: follow the single closest neighbor at this layer.
    fn greedy_closest(
        &self,
        query: &[f32],
        mut current: u32,
        level: usize,
        vectors: &VectorStorage,
    ) -> u32 {
        let mut current_dist = self.compute_distance(query, vectors.get_vector(current));
        loop {
            let mut changed = false;
            for &neighbor in &self.layers[level].neighbors[current as usize] {
                let dist = self.compute_distance(query, vectors.get_vector(neighbor));
                if dist < current_dist {
                    current = neighbor;
                    current_dist = dist;
                    changed = true;
                }
            }
            if !changed {
                return current;
            }
        }
    }

    /// Prune a node's connection list to keep only the closest `max_conn` neighbors.
    fn prune_connections(
        &mut self,
        node_id: u32,
        max_conn: usize,
        level: usize,
        vectors: &VectorStorage,
    ) {
        let node_vec = vectors.get_vector(node_id);
        let neighbors = &mut self.layers[level].neighbors[node_id as usize];

        // Sort by distance to node, keep closest
        neighbors.sort_by(|&a, &b| {
            let da = self.compute_distance(node_vec, vectors.get_vector(a));
            let db = self.compute_distance(node_vec, vectors.get_vector(b));
            da.partial_cmp(&db).unwrap_or(std::cmp::Ordering::Equal)
        });
        neighbors.truncate(max_conn);
    }
}
```

### Search Algorithm

Beam search with `ef` parameter controlling the beam width. Higher `ef` = better recall, slower search. At query time, `ef` should be >= `k` (the number of results requested).

```rust
use std::collections::HashSet;

impl HnswIndex {
    /// Search for the k nearest neighbors of the query vector.
    /// `ef` controls search quality: higher ef = better recall, slower.
    /// Must be >= k. Typical: ef = 2*k to 10*k.
    pub fn search(
        &self,
        query: &[f32],
        k: usize,
        ef: usize,
        vectors: &VectorStorage,
    ) -> Vec<Candidate> {
        let entry = match self.entry_point {
            Some(ep) => ep,
            None => return Vec::new(),
        };

        let mut current_ep = entry;

        // Phase 1: Greedy descent through upper layers to find a good entry
        // point for the bottom layer search.
        for level in (1..=self.max_level).rev() {
            current_ep = self.greedy_closest(query, current_ep, level, vectors);
        }

        // Phase 2: Beam search on layer 0 with ef candidates.
        let mut results = self.search_layer(query, current_ep, ef, 0, vectors);

        // Return top-k
        results.truncate(k);
        results
    }

    /// Beam search on a single layer. Returns up to `ef` candidates
    /// sorted by distance (ascending — closest first).
    fn search_layer(
        &self,
        query: &[f32],
        entry_point: u32,
        ef: usize,
        level: usize,
        vectors: &VectorStorage,
    ) -> Vec<Candidate> {
        let mut visited = HashSet::new();
        visited.insert(entry_point);

        let entry_dist = self.compute_distance(query, vectors.get_vector(entry_point));
        let entry_candidate = Candidate { distance: entry_dist, id: entry_point };

        // Min-heap of candidates to explore (closest first)
        let mut candidates: BinaryHeap<Reverse<Candidate>> = BinaryHeap::new();
        candidates.push(Reverse(entry_candidate.clone()));

        // Max-heap of current best results (farthest first for easy eviction)
        let mut results: BinaryHeap<Candidate> = BinaryHeap::new();
        results.push(entry_candidate);

        while let Some(Reverse(current)) = candidates.pop() {
            // If the closest candidate is farther than the farthest result,
            // we cannot improve — stop.
            let farthest_result = results.peek().unwrap().distance;
            if current.distance > farthest_result && results.len() >= ef {
                break;
            }

            // Explore neighbors of the current candidate
            for &neighbor_id in &self.layers[level].neighbors[current.id as usize] {
                if visited.contains(&neighbor_id) {
                    continue;
                }
                visited.insert(neighbor_id);

                let dist = self.compute_distance(query, vectors.get_vector(neighbor_id));
                let neighbor = Candidate { distance: dist, id: neighbor_id };

                let farthest = results.peek().unwrap().distance;

                // Add if we have room, or if this neighbor is closer than the farthest result
                if results.len() < ef || dist < farthest {
                    candidates.push(Reverse(neighbor.clone()));
                    results.push(neighbor);

                    // Evict the farthest if over capacity
                    if results.len() > ef {
                        results.pop();
                    }
                }
            }
        }

        // Drain into a sorted vec (closest first)
        let mut sorted: Vec<Candidate> = results.into_vec();
        sorted.sort_by(|a, b| a.distance.partial_cmp(&b.distance).unwrap());
        sorted
    }

    /// Dispatch to the configured distance function.
    #[inline]
    fn compute_distance(&self, a: &[f32], b: &[f32]) -> f32 {
        match self.distance_fn {
            DistanceFunction::Cosine => cosine_distance(a, b),
            DistanceFunction::L2 => l2_distance(a, b),
            DistanceFunction::DotProduct => dot_product_distance(a, b),
            DistanceFunction::Manhattan => manhattan_distance(a, b),
        }
    }
}
```

### SIMD Distance Functions

Runtime CPU feature detection dispatches to the fastest available implementation. SIMD kernels process 8 floats per iteration (AVX2) or 4 (SSE4.1). Scalar fallback always available.

#### Runtime Dispatch

```rust
use std::sync::OnceLock;

type DistanceFn = fn(&[f32], &[f32]) -> f32;

/// Detect CPU features once, cache the best implementation.
fn select_cosine_impl() -> DistanceFn {
    #[cfg(target_arch = "x86_64")]
    {
        if is_x86_feature_detected!("avx2") && is_x86_feature_detected!("fma") {
            return |a, b| unsafe { cosine_distance_avx2(a, b) };
        }
        if is_x86_feature_detected!("sse4.1") {
            return |a, b| unsafe { cosine_distance_sse41(a, b) };
        }
    }
    #[cfg(target_arch = "aarch64")]
    {
        // NEON is always available on aarch64
        return |a, b| unsafe { cosine_distance_neon(a, b) };
    }
    cosine_distance_scalar
}

static COSINE_FN: OnceLock<DistanceFn> = OnceLock::new();
static L2_FN: OnceLock<DistanceFn> = OnceLock::new();
static DOT_FN: OnceLock<DistanceFn> = OnceLock::new();
static MANHATTAN_FN: OnceLock<DistanceFn> = OnceLock::new();

/// Public dispatch functions — resolve once, then direct call.
pub fn cosine_distance(a: &[f32], b: &[f32]) -> f32 {
    COSINE_FN.get_or_init(select_cosine_impl)(a, b)
}

pub fn l2_distance(a: &[f32], b: &[f32]) -> f32 {
    L2_FN.get_or_init(select_l2_impl)(a, b)
}

pub fn dot_product_distance(a: &[f32], b: &[f32]) -> f32 {
    DOT_FN.get_or_init(select_dot_impl)(a, b)
}

pub fn manhattan_distance(a: &[f32], b: &[f32]) -> f32 {
    MANHATTAN_FN.get_or_init(select_manhattan_impl)(a, b)
}
```

#### Cosine Distance — AVX2

```rust
#[cfg(target_arch = "x86_64")]
use std::arch::x86_64::*;

/// Cosine distance = 1 - (a . b) / (|a| * |b|)
/// Processes 8 f32 values per loop iteration using 256-bit AVX2 registers.
/// FMA (fused multiply-add) for dot product accumulation.
#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2", enable = "fma")]
unsafe fn cosine_distance_avx2(a: &[f32], b: &[f32]) -> f32 {
    debug_assert_eq!(a.len(), b.len());
    let n = a.len();
    let chunks = n / 8;

    let mut dot_acc = _mm256_setzero_ps();    // a . b accumulator
    let mut norm_a_acc = _mm256_setzero_ps(); // |a|^2 accumulator
    let mut norm_b_acc = _mm256_setzero_ps(); // |b|^2 accumulator

    let a_ptr = a.as_ptr();
    let b_ptr = b.as_ptr();

    for i in 0..chunks {
        let offset = i * 8;
        let va = _mm256_loadu_ps(a_ptr.add(offset));
        let vb = _mm256_loadu_ps(b_ptr.add(offset));

        // FMA: acc = acc + va * vb (single instruction, no intermediate rounding)
        dot_acc = _mm256_fmadd_ps(va, vb, dot_acc);
        norm_a_acc = _mm256_fmadd_ps(va, va, norm_a_acc);
        norm_b_acc = _mm256_fmadd_ps(vb, vb, norm_b_acc);
    }

    // Horizontal sum: reduce 8-lane accumulator to scalar
    let dot = hsum_avx2(dot_acc);
    let norm_a = hsum_avx2(norm_a_acc);
    let norm_b = hsum_avx2(norm_b_acc);

    // Handle tail elements (n % 8 != 0)
    let mut dot_tail = dot;
    let mut norm_a_tail = norm_a;
    let mut norm_b_tail = norm_b;
    for i in (chunks * 8)..n {
        let ai = *a_ptr.add(i);
        let bi = *b_ptr.add(i);
        dot_tail += ai * bi;
        norm_a_tail += ai * ai;
        norm_b_tail += bi * bi;
    }

    let denom = (norm_a_tail * norm_b_tail).sqrt();
    if denom == 0.0 {
        1.0 // Maximum distance if either vector is zero
    } else {
        1.0 - (dot_tail / denom)
    }
}

/// Horizontal sum of an __m256 register (8 f32 lanes → 1 f32).
#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
#[inline]
unsafe fn hsum_avx2(v: __m256) -> f32 {
    // [a0+a4, a1+a5, a2+a6, a3+a7] (128-bit)
    let hi128 = _mm256_extractf128_ps(v, 1);
    let lo128 = _mm256_castps256_ps128(v);
    let sum128 = _mm_add_ps(lo128, hi128);
    // [s0+s2, s1+s3, ...]
    let shuf = _mm_movehdup_ps(sum128);
    let sums = _mm_add_ps(sum128, shuf);
    // [s0+s1+s2+s3, ...]
    let shuf2 = _mm_movehl_ps(sums, sums);
    let result = _mm_add_ss(sums, shuf2);
    _mm_cvtss_f32(result)
}
```

#### L2 (Euclidean) Distance — AVX2

```rust
/// L2 squared distance. Take sqrt at the end only if needed for thresholds;
/// for ranking, squared distance preserves ordering and avoids the sqrt cost.
#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2", enable = "fma")]
unsafe fn l2_distance_avx2(a: &[f32], b: &[f32]) -> f32 {
    debug_assert_eq!(a.len(), b.len());
    let n = a.len();
    let chunks = n / 8;

    let mut sum_acc = _mm256_setzero_ps();
    let a_ptr = a.as_ptr();
    let b_ptr = b.as_ptr();

    for i in 0..chunks {
        let offset = i * 8;
        let va = _mm256_loadu_ps(a_ptr.add(offset));
        let vb = _mm256_loadu_ps(b_ptr.add(offset));
        let diff = _mm256_sub_ps(va, vb);
        // sum += diff^2
        sum_acc = _mm256_fmadd_ps(diff, diff, sum_acc);
    }

    let mut sum = hsum_avx2(sum_acc);

    // Tail
    for i in (chunks * 8)..n {
        let d = *a_ptr.add(i) - *b_ptr.add(i);
        sum += d * d;
    }

    sum.sqrt()
}
```

#### Dot Product Distance — AVX2

```rust
/// Negative dot product distance: higher dot product = more similar,
/// so distance = -dot(a, b). For normalized vectors, equivalent to cosine.
#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2", enable = "fma")]
unsafe fn dot_product_distance_avx2(a: &[f32], b: &[f32]) -> f32 {
    debug_assert_eq!(a.len(), b.len());
    let n = a.len();
    let chunks = n / 8;

    let mut dot_acc = _mm256_setzero_ps();
    let a_ptr = a.as_ptr();
    let b_ptr = b.as_ptr();

    for i in 0..chunks {
        let offset = i * 8;
        let va = _mm256_loadu_ps(a_ptr.add(offset));
        let vb = _mm256_loadu_ps(b_ptr.add(offset));
        dot_acc = _mm256_fmadd_ps(va, vb, dot_acc);
    }

    let mut dot = hsum_avx2(dot_acc);

    for i in (chunks * 8)..n {
        dot += *a_ptr.add(i) * *b_ptr.add(i);
    }

    -dot // Negate so lower = more similar
}
```

#### Manhattan Distance — AVX2

```rust
/// Manhattan (L1) distance: sum of absolute differences.
#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
unsafe fn manhattan_distance_avx2(a: &[f32], b: &[f32]) -> f32 {
    debug_assert_eq!(a.len(), b.len());
    let n = a.len();
    let chunks = n / 8;

    // Mask to clear the sign bit: abs(x) = x & 0x7FFFFFFF
    let sign_mask = _mm256_castsi256_ps(_mm256_set1_epi32(0x7FFF_FFFFu32 as i32));
    let mut sum_acc = _mm256_setzero_ps();
    let a_ptr = a.as_ptr();
    let b_ptr = b.as_ptr();

    for i in 0..chunks {
        let offset = i * 8;
        let va = _mm256_loadu_ps(a_ptr.add(offset));
        let vb = _mm256_loadu_ps(b_ptr.add(offset));
        let diff = _mm256_sub_ps(va, vb);
        let abs_diff = _mm256_and_ps(diff, sign_mask);
        sum_acc = _mm256_add_ps(sum_acc, abs_diff);
    }

    let mut sum = hsum_avx2(sum_acc);

    for i in (chunks * 8)..n {
        sum += (*a_ptr.add(i) - *b_ptr.add(i)).abs();
    }

    sum
}
```

#### Scalar Fallbacks

```rust
/// Scalar cosine distance — works on all platforms, no SIMD required.
fn cosine_distance_scalar(a: &[f32], b: &[f32]) -> f32 {
    debug_assert_eq!(a.len(), b.len());
    let mut dot = 0.0f32;
    let mut norm_a = 0.0f32;
    let mut norm_b = 0.0f32;

    for i in 0..a.len() {
        dot += a[i] * b[i];
        norm_a += a[i] * a[i];
        norm_b += b[i] * b[i];
    }

    let denom = (norm_a * norm_b).sqrt();
    if denom == 0.0 { 1.0 } else { 1.0 - (dot / denom) }
}

fn l2_distance_scalar(a: &[f32], b: &[f32]) -> f32 {
    debug_assert_eq!(a.len(), b.len());
    let mut sum = 0.0f32;
    for i in 0..a.len() {
        let d = a[i] - b[i];
        sum += d * d;
    }
    sum.sqrt()
}

fn dot_product_distance_scalar(a: &[f32], b: &[f32]) -> f32 {
    debug_assert_eq!(a.len(), b.len());
    let mut dot = 0.0f32;
    for i in 0..a.len() {
        dot += a[i] * b[i];
    }
    -dot
}

fn manhattan_distance_scalar(a: &[f32], b: &[f32]) -> f32 {
    debug_assert_eq!(a.len(), b.len());
    let mut sum = 0.0f32;
    for i in 0..a.len() {
        sum += (a[i] - b[i]).abs();
    }
    sum
}
```

#### NEON (aarch64 / Apple Silicon)

```rust
#[cfg(target_arch = "aarch64")]
use std::arch::aarch64::*;

/// Cosine distance using ARM NEON — 128-bit, 4 f32 per iteration.
/// Always available on aarch64 (no feature detection needed).
#[cfg(target_arch = "aarch64")]
unsafe fn cosine_distance_neon(a: &[f32], b: &[f32]) -> f32 {
    debug_assert_eq!(a.len(), b.len());
    let n = a.len();
    let chunks = n / 4;

    let mut dot_acc = vdupq_n_f32(0.0);
    let mut norm_a_acc = vdupq_n_f32(0.0);
    let mut norm_b_acc = vdupq_n_f32(0.0);

    let a_ptr = a.as_ptr();
    let b_ptr = b.as_ptr();

    for i in 0..chunks {
        let offset = i * 4;
        let va = vld1q_f32(a_ptr.add(offset));
        let vb = vld1q_f32(b_ptr.add(offset));

        dot_acc = vfmaq_f32(dot_acc, va, vb);
        norm_a_acc = vfmaq_f32(norm_a_acc, va, va);
        norm_b_acc = vfmaq_f32(norm_b_acc, vb, vb);
    }

    let mut dot = vaddvq_f32(dot_acc);
    let mut norm_a = vaddvq_f32(norm_a_acc);
    let mut norm_b = vaddvq_f32(norm_b_acc);

    for i in (chunks * 4)..n {
        let ai = *a_ptr.add(i);
        let bi = *b_ptr.add(i);
        dot += ai * bi;
        norm_a += ai * ai;
        norm_b += bi * bi;
    }

    let denom = (norm_a * norm_b).sqrt();
    if denom == 0.0 { 1.0 } else { 1.0 - (dot / denom) }
}
```

### Quantization

Reduce memory footprint and improve cache utilization at the cost of some recall accuracy.

#### Scalar Quantization (SQ8) — f32 to i8

4x memory reduction. Each dimension is linearly mapped from its [min, max] range to [-128, 127]. Approximately 5% recall loss for most embedding models.

```rust
/// Quantization parameters for one dimension.
pub struct SQ8Params {
    /// Per-dimension min values (length = dim)
    min: Vec<f32>,
    /// Per-dimension scale: (max - min) / 255.0
    scale: Vec<f32>,
}

impl SQ8Params {
    /// Learn quantization parameters from a sample of vectors.
    /// The sample should be representative of the full dataset.
    pub fn train(vectors: &[&[f32]], dim: usize) -> Self {
        let mut min = vec![f32::INFINITY; dim];
        let mut max = vec![f32::NEG_INFINITY; dim];

        for v in vectors {
            for (i, &val) in v.iter().enumerate() {
                if val < min[i] { min[i] = val; }
                if val > max[i] { max[i] = val; }
            }
        }

        let scale: Vec<f32> = min.iter().zip(max.iter())
            .map(|(&lo, &hi)| {
                let range = hi - lo;
                if range == 0.0 { 1.0 } else { range / 255.0 }
            })
            .collect();

        Self { min, scale }
    }

    /// Quantize a single f32 vector to i8.
    pub fn quantize(&self, vector: &[f32]) -> Vec<i8> {
        vector.iter().enumerate().map(|(i, &val)| {
            let normalized = (val - self.min[i]) / self.scale[i];
            // Map [0, 255] to [-128, 127]
            (normalized.clamp(0.0, 255.0) as u8).wrapping_sub(128) as i8
        }).collect()
    }

    /// Dequantize back to approximate f32 values.
    pub fn dequantize(&self, quantized: &[i8]) -> Vec<f32> {
        quantized.iter().enumerate().map(|(i, &val)| {
            let unsigned = (val as i16 + 128) as f32;
            unsigned * self.scale[i] + self.min[i]
        }).collect()
    }

    /// Compute approximate distance directly on quantized vectors.
    /// Avoids full dequantization — use integer arithmetic where possible.
    pub fn quantized_l2_distance(&self, a: &[i8], b: &[i8]) -> f32 {
        debug_assert_eq!(a.len(), b.len());
        let mut sum: i32 = 0;
        for i in 0..a.len() {
            let diff = a[i] as i32 - b[i] as i32;
            sum += diff * diff;
        }
        // Approximate — scale is dimension-dependent, but for ranking
        // this monotonic transform preserves ordering
        (sum as f32).sqrt()
    }
}
```

#### Product Quantization (PQ) — Higher Compression

Split each vector into `num_sub` sub-vectors, quantize each sub-vector to a centroid ID from a codebook trained via k-means. Compression ratio: `dim * 4 bytes` down to `num_sub * 1 byte` (with 256 centroids per sub-space).

```rust
/// Product quantization codebook.
pub struct PQCodebook {
    /// num_sub sub-quantizers, each with 256 centroids of sub_dim dimensions.
    /// Shape: [num_sub][256][sub_dim]
    centroids: Vec<Vec<Vec<f32>>>,
    /// Number of sub-vectors
    num_sub: usize,
    /// Dimension of each sub-vector
    sub_dim: usize,
}

impl PQCodebook {
    /// Train the codebook from a sample of vectors using k-means.
    /// `num_sub` must evenly divide `dim`.
    pub fn train(
        vectors: &[&[f32]],
        dim: usize,
        num_sub: usize,
        iterations: usize,
    ) -> Self {
        assert_eq!(dim % num_sub, 0);
        let sub_dim = dim / num_sub;
        let mut centroids = Vec::with_capacity(num_sub);

        for sub_idx in 0..num_sub {
            let start = sub_idx * sub_dim;
            let end = start + sub_dim;

            // Extract sub-vectors for this partition
            let sub_vectors: Vec<Vec<f32>> = vectors.iter()
                .map(|v| v[start..end].to_vec())
                .collect();

            // k-means with 256 clusters (fits in u8 code)
            let sub_centroids = kmeans_256(&sub_vectors, sub_dim, iterations);
            centroids.push(sub_centroids);
        }

        Self { centroids, num_sub, sub_dim }
    }

    /// Encode a vector to PQ codes (one u8 per sub-vector).
    pub fn encode(&self, vector: &[f32]) -> Vec<u8> {
        let mut codes = Vec::with_capacity(self.num_sub);
        for sub_idx in 0..self.num_sub {
            let start = sub_idx * self.sub_dim;
            let sub_vec = &vector[start..start + self.sub_dim];

            // Find nearest centroid in this sub-space
            let mut best_id = 0u8;
            let mut best_dist = f32::INFINITY;
            for (c_id, centroid) in self.centroids[sub_idx].iter().enumerate() {
                let dist = l2_distance_scalar(sub_vec, centroid);
                if dist < best_dist {
                    best_dist = dist;
                    best_id = c_id as u8;
                }
            }
            codes.push(best_id);
        }
        codes
    }

    /// Asymmetric distance computation: exact query sub-vectors vs quantized codes.
    /// Precompute a distance table: dist_table[sub][code] = distance from query sub-vector
    /// to centroid. Then sum up the table lookups — very fast.
    pub fn asymmetric_distance(&self, query: &[f32], codes: &[u8]) -> f32 {
        let mut dist = 0.0f32;
        for sub_idx in 0..self.num_sub {
            let start = sub_idx * self.sub_dim;
            let query_sub = &query[start..start + self.sub_dim];
            let centroid = &self.centroids[sub_idx][codes[sub_idx] as usize];
            dist += l2_distance_scalar(query_sub, centroid);
        }
        dist
    }

    /// Precompute distance table for fast batch lookups.
    /// Returns [num_sub][256] table of distances from query to each centroid.
    pub fn precompute_distance_table(&self, query: &[f32]) -> Vec<Vec<f32>> {
        let mut table = Vec::with_capacity(self.num_sub);
        for sub_idx in 0..self.num_sub {
            let start = sub_idx * self.sub_dim;
            let query_sub = &query[start..start + self.sub_dim];
            let sub_table: Vec<f32> = self.centroids[sub_idx].iter()
                .map(|centroid| l2_distance_scalar(query_sub, centroid))
                .collect();
            table.push(sub_table);
        }
        table
    }

    /// Fast distance using precomputed table — just num_sub table lookups + additions.
    pub fn table_distance(table: &[Vec<f32>], codes: &[u8]) -> f32 {
        let mut dist = 0.0f32;
        for (sub_idx, &code) in codes.iter().enumerate() {
            dist += table[sub_idx][code as usize];
        }
        dist
    }
}

/// k-means clustering producing 256 centroids for sub-vectors.
/// Standard Lloyd's algorithm. In production, use k-means++ initialization.
fn kmeans_256(vectors: &[Vec<f32>], dim: usize, iterations: usize) -> Vec<Vec<f32>> {
    use rand::seq::SliceRandom;
    let mut rng = rand::thread_rng();

    // Initialize centroids by sampling 256 vectors
    let mut centroids: Vec<Vec<f32>> = vectors
        .choose_multiple(&mut rng, 256.min(vectors.len()))
        .cloned()
        .collect();

    // Pad if fewer than 256 vectors
    while centroids.len() < 256 {
        centroids.push(vec![0.0; dim]);
    }

    for _ in 0..iterations {
        // Assign each vector to nearest centroid
        let mut assignments: Vec<Vec<Vec<f32>>> = vec![Vec::new(); 256];
        for v in vectors {
            let mut best = 0usize;
            let mut best_dist = f32::INFINITY;
            for (i, c) in centroids.iter().enumerate() {
                let d = l2_distance_scalar(v, c);
                if d < best_dist {
                    best_dist = d;
                    best = i;
                }
            }
            assignments[best].push(v.clone());
        }

        // Update centroids to mean of assigned vectors
        for (i, assigned) in assignments.iter().enumerate() {
            if assigned.is_empty() { continue; }
            let mut new_centroid = vec![0.0f32; dim];
            for v in assigned {
                for (j, &val) in v.iter().enumerate() {
                    new_centroid[j] += val;
                }
            }
            let n = assigned.len() as f32;
            for val in &mut new_centroid {
                *val /= n;
            }
            centroids[i] = new_centroid;
        }
    }

    centroids
}
```

### Filtered Vector Search

Combine metadata predicates with vector similarity. The strategy depends on the selectivity of the filter — how many vectors pass it.

```rust
/// Filter predicate applied to vector metadata.
pub trait VectorFilter: Send + Sync {
    /// Returns true if the vector at this ID passes the filter.
    fn matches(&self, id: u32) -> bool;

    /// Estimated selectivity: fraction of vectors that pass (0.0 to 1.0).
    /// Used to choose pre-filter vs post-filter strategy.
    fn estimated_selectivity(&self) -> f64;
}

/// Filtered search strategy selection.
/// - Pre-filter: apply filter first, then vector search on the filtered subset.
///   Best when selectivity is low (few vectors pass) — avoids scanning irrelevant vectors.
/// - Post-filter: vector search first, then discard non-matching results.
///   Best when selectivity is high (most vectors pass) — HNSW graph stays connected.
///
/// Threshold: ~1-5% is the crossover point. Below 1%, pre-filter wins.
/// Above 5%, post-filter preserves graph connectivity and recall.
const PRE_FILTER_THRESHOLD: f64 = 0.05;

impl HnswIndex {
    /// Filtered k-NN search with automatic strategy selection.
    pub fn search_filtered(
        &self,
        query: &[f32],
        k: usize,
        ef: usize,
        filter: &dyn VectorFilter,
        vectors: &VectorStorage,
    ) -> Vec<Candidate> {
        let selectivity = filter.estimated_selectivity();

        if selectivity < PRE_FILTER_THRESHOLD {
            self.pre_filtered_search(query, k, filter, vectors)
        } else {
            self.post_filtered_search(query, k, ef, filter, vectors)
        }
    }

    /// Pre-filter: brute-force on the filtered subset.
    /// When very few vectors match, brute force on the small subset beats
    /// traversing the HNSW graph (which might skip matching nodes).
    fn pre_filtered_search(
        &self,
        query: &[f32],
        k: usize,
        filter: &dyn VectorFilter,
        vectors: &VectorStorage,
    ) -> Vec<Candidate> {
        let mut candidates: BinaryHeap<Candidate> = BinaryHeap::new();

        for id in 0..vectors.len() {
            if !filter.matches(id) {
                continue;
            }
            let dist = self.compute_distance(query, vectors.get_vector(id));
            let candidate = Candidate { distance: dist, id };

            if candidates.len() < k {
                candidates.push(candidate);
            } else if dist < candidates.peek().unwrap().distance {
                candidates.pop();
                candidates.push(candidate);
            }
        }

        let mut results: Vec<Candidate> = candidates.into_vec();
        results.sort_by(|a, b| a.distance.partial_cmp(&b.distance).unwrap());
        results
    }

    /// Post-filter: HNSW search with oversampling, then filter.
    /// Request more candidates (ef * oversample_factor), then discard
    /// non-matching results. Works well when most vectors pass the filter.
    fn post_filtered_search(
        &self,
        query: &[f32],
        k: usize,
        ef: usize,
        filter: &dyn VectorFilter,
        vectors: &VectorStorage,
    ) -> Vec<Candidate> {
        // Oversample: fetch more candidates to compensate for filtered-out results
        let oversample_factor = (1.0 / filter.estimated_selectivity().max(0.01)) as usize;
        let expanded_ef = ef * oversample_factor.min(10); // Cap at 10x

        let candidates = self.search(query, expanded_ef, expanded_ef, vectors);

        candidates
            .into_iter()
            .filter(|c| filter.matches(c.id))
            .take(k)
            .collect()
    }
}
```

---

## Hybrid Search — BM25 + Vector

Combine full-text BM25 scores with vector similarity scores for results that match on both keyword relevance and semantic meaning.

### Reciprocal Rank Fusion (RRF)

Rank-based combination — does not require score normalization. Each result gets `1/(k + rank)` from each source. Robust when score distributions differ wildly between BM25 and vector search.

```rust
use std::collections::HashMap;

/// RRF result: document ID and fused score.
#[derive(Debug, Clone)]
pub struct HybridResult {
    pub doc_id: u32,
    pub score: f64,
    pub bm25_rank: Option<usize>,
    pub vector_rank: Option<usize>,
}

/// Reciprocal Rank Fusion.
/// k is a smoothing constant (typically 60). Higher k reduces the influence
/// of high-ranking documents, making the fusion more uniform.
///
/// score(doc) = sum over sources of 1/(k + rank_in_source)
///
/// Documents appearing in both lists get contributions from both.
/// Documents in only one list still contribute, just less.
pub fn rrf_combine(
    bm25_results: &[(u32, f32)],   // (doc_id, bm25_score) — ordered by score desc
    vector_results: &[(u32, f32)],  // (doc_id, distance) — ordered by distance asc
    k: f64,
    limit: usize,
) -> Vec<HybridResult> {
    let mut scores: HashMap<u32, HybridResult> = HashMap::new();

    // BM25 ranks (rank 1 = best match)
    for (rank, &(doc_id, _)) in bm25_results.iter().enumerate() {
        let rrf_score = 1.0 / (k + (rank + 1) as f64);
        scores.entry(doc_id)
            .and_modify(|r| {
                r.score += rrf_score;
                r.bm25_rank = Some(rank + 1);
            })
            .or_insert(HybridResult {
                doc_id,
                score: rrf_score,
                bm25_rank: Some(rank + 1),
                vector_rank: None,
            });
    }

    // Vector ranks (rank 1 = closest vector)
    for (rank, &(doc_id, _)) in vector_results.iter().enumerate() {
        let rrf_score = 1.0 / (k + (rank + 1) as f64);
        scores.entry(doc_id)
            .and_modify(|r| {
                r.score += rrf_score;
                r.vector_rank = Some(rank + 1);
            })
            .or_insert(HybridResult {
                doc_id,
                score: rrf_score,
                bm25_rank: None,
                vector_rank: Some(rank + 1),
            });
    }

    // Sort by fused score descending
    let mut results: Vec<HybridResult> = scores.into_values().collect();
    results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap());
    results.truncate(limit);
    results
}
```

### Weighted Score Combination

Score-based combination — requires normalizing scores from both sources to [0, 1]. More tunable than RRF via the alpha parameter, but sensitive to score distribution changes.

```rust
/// Weighted combination of BM25 and vector scores.
/// alpha: weight for BM25 (0.0 = pure vector, 1.0 = pure BM25).
/// Typical starting point: alpha = 0.3 (favor semantic similarity).
///
/// Scores are min-max normalized to [0, 1] before combining.
/// BM25 scores: higher = more relevant (normalize as-is).
/// Vector distances: lower = more similar (invert: similarity = 1 - normalized_distance).
pub fn weighted_combine(
    bm25_results: &[(u32, f32)],
    vector_results: &[(u32, f32)],
    alpha: f32,
    limit: usize,
) -> Vec<(u32, f32)> {
    // Normalize BM25 scores to [0, 1]
    let bm25_normalized = min_max_normalize(
        bm25_results,
        false, // higher = better, no inversion
    );

    // Normalize vector distances to [0, 1] then invert (lower distance = higher similarity)
    let vector_normalized = min_max_normalize(
        vector_results,
        true, // lower = better, invert to similarity
    );

    // Combine
    let mut combined: HashMap<u32, f32> = HashMap::new();

    for &(doc_id, norm_score) in &bm25_normalized {
        *combined.entry(doc_id).or_default() += alpha * norm_score;
    }

    for &(doc_id, norm_score) in &vector_normalized {
        *combined.entry(doc_id).or_default() += (1.0 - alpha) * norm_score;
    }

    let mut results: Vec<(u32, f32)> = combined.into_iter().collect();
    results.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
    results.truncate(limit);
    results
}

/// Min-max normalize scores to [0, 1]. If `invert`, flip so lower input = higher output.
fn min_max_normalize(scores: &[(u32, f32)], invert: bool) -> Vec<(u32, f32)> {
    if scores.is_empty() {
        return Vec::new();
    }

    let min = scores.iter().map(|s| s.1).fold(f32::INFINITY, f32::min);
    let max = scores.iter().map(|s| s.1).fold(f32::NEG_INFINITY, f32::max);
    let range = max - min;

    scores.iter().map(|&(id, score)| {
        let normalized = if range == 0.0 {
            0.5
        } else if invert {
            1.0 - (score - min) / range
        } else {
            (score - min) / range
        };
        (id, normalized)
    }).collect()
}
```

### End-to-End Hybrid Search

```rust
/// Unified hybrid search: runs BM25 and vector search in parallel,
/// combines with the chosen fusion strategy.
pub struct HybridSearchEngine {
    fts_index: Index,
    fts_reader: tantivy::IndexReader,
    fts_schema: Schema,
    hnsw: HnswIndex,
    vectors: VectorStorage,
    embedding_model: Box<dyn EmbeddingModel>,
}

pub enum FusionStrategy {
    /// Reciprocal Rank Fusion with parameter k
    RRF { k: f64 },
    /// Weighted combination with alpha (0=pure vector, 1=pure BM25)
    Weighted { alpha: f32 },
}

impl HybridSearchEngine {
    /// Execute a hybrid search query.
    /// 1. Generate embedding from query text
    /// 2. Run BM25 and vector search (can be parallelized)
    /// 3. Fuse results
    pub async fn search(
        &self,
        query_text: &str,
        limit: usize,
        strategy: &FusionStrategy,
    ) -> Result<Vec<HybridResult>, SearchError> {
        // Generate query embedding
        let query_embedding = self.embedding_model.embed(query_text).await?;

        // BM25 search
        let bm25_results = search_bm25(
            &self.fts_index,
            &self.fts_reader,
            &self.fts_schema,
            query_text,
            limit * 3, // Fetch more candidates for fusion
        )?;
        let bm25_pairs: Vec<(u32, f32)> = bm25_results
            .iter()
            .enumerate()
            .map(|(_, (score, doc))| {
                let doc_id_field = self.fts_schema.get_field("doc_id").unwrap();
                let doc_id_str = doc.get_first(doc_id_field)
                    .and_then(|v| v.as_str())
                    .unwrap_or("0");
                let doc_id: u32 = doc_id_str.parse().unwrap_or(0);
                (doc_id, *score)
            })
            .collect();

        // Vector search
        let ef = (limit * 5).max(50);
        let vector_results = self.hnsw.search(&query_embedding, limit * 3, ef, &self.vectors);
        let vector_pairs: Vec<(u32, f32)> = vector_results
            .iter()
            .map(|c| (c.id, c.distance))
            .collect();

        // Fuse
        let fused = match strategy {
            FusionStrategy::RRF { k } => {
                rrf_combine(&bm25_pairs, &vector_pairs, *k, limit)
            }
            FusionStrategy::Weighted { alpha } => {
                let combined = weighted_combine(&bm25_pairs, &vector_pairs, *alpha, limit);
                combined.into_iter().map(|(doc_id, score)| HybridResult {
                    doc_id,
                    score: score as f64,
                    bm25_rank: None,
                    vector_rank: None,
                }).collect()
            }
        };

        Ok(fused)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SearchError {
    #[error("tantivy error: {0}")]
    Tantivy(#[from] tantivy::TantivyError),
    #[error("embedding error: {0}")]
    Embedding(String),
    #[error("query parse error: {0}")]
    QueryParse(#[from] tantivy::query::QueryParserError),
}
```

### Fusion Strategy Selection

```
Query has strong keywords (proper nouns, technical terms, exact phrases)?
├─ YES → alpha=0.6-0.8 (favor BM25) or RRF with k=60
└─ NO → conceptual/semantic query?
    ├─ YES → alpha=0.2-0.3 (favor vector) or RRF with k=60
    └─ MIXED → alpha=0.5 or RRF with k=60 (RRF is more forgiving)
```

RRF with k=60 is the safe default — it works well without tuning and handles score distribution mismatches gracefully.

---

## Embedding Engine Integration

### Trait Definition

```rust
use async_trait::async_trait;

/// Pluggable embedding model — local inference or remote API.
/// All implementations must be thread-safe (Send + Sync) for use
/// across async tasks and the indexing pipeline.
#[async_trait]
pub trait EmbeddingModel: Send + Sync {
    /// Dimensionality of the output vectors.
    fn dimensions(&self) -> usize;

    /// Model identifier (for logging, config).
    fn model_name(&self) -> &str;

    /// Embed a single text. For bulk operations, prefer embed_batch.
    async fn embed(&self, text: &str) -> Result<Vec<f32>, EmbeddingError>;

    /// Batch embedding — implementations should optimize for throughput.
    /// Default: sequential calls to embed(). Override for batched inference.
    async fn embed_batch(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>, EmbeddingError> {
        let mut results = Vec::with_capacity(texts.len());
        for text in texts {
            results.push(self.embed(text).await?);
        }
        Ok(results)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum EmbeddingError {
    #[error("model inference failed: {0}")]
    Inference(String),
    #[error("HTTP request failed: {0}")]
    Http(#[from] reqwest::Error),
    #[error("text too long: {len} chars (max {max})")]
    TextTooLong { len: usize, max: usize },
    #[error("batch too large: {size} (max {max})")]
    BatchTooLarge { size: usize, max: usize },
}
```

### Local Model via candle

```rust
use candle_core::{Device, Tensor};
use candle_transformers::models::bert::{BertModel, Config as BertConfig};
use tokenizers::Tokenizer;

/// Local embedding model using candle for inference.
/// Loads the model once, runs inference on CPU or GPU.
pub struct LocalEmbeddingModel {
    model: BertModel,
    tokenizer: Tokenizer,
    device: Device,
    dim: usize,
    name: String,
    max_tokens: usize,
}

impl LocalEmbeddingModel {
    /// Load a model from a local directory (HuggingFace format).
    /// `model_path` should contain config.json, model.safetensors, tokenizer.json.
    pub fn load(model_path: &std::path::Path, device: Device) -> Result<Self, EmbeddingError> {
        let config_path = model_path.join("config.json");
        let config_str = std::fs::read_to_string(&config_path)
            .map_err(|e| EmbeddingError::Inference(format!("config: {e}")))?;
        let config: BertConfig = serde_json::from_str(&config_str)
            .map_err(|e| EmbeddingError::Inference(format!("config parse: {e}")))?;

        let weights_path = model_path.join("model.safetensors");
        let vb = unsafe {
            candle_nn::VarBuilder::from_mmaped_safetensors(
                &[weights_path], candle_core::DType::F32, &device,
            ).map_err(|e| EmbeddingError::Inference(format!("weights: {e}")))?
        };

        let model = BertModel::load(vb, &config)
            .map_err(|e| EmbeddingError::Inference(format!("model: {e}")))?;

        let tokenizer_path = model_path.join("tokenizer.json");
        let tokenizer = Tokenizer::from_file(&tokenizer_path)
            .map_err(|e| EmbeddingError::Inference(format!("tokenizer: {e}")))?;

        Ok(Self {
            model,
            tokenizer,
            device,
            dim: config.hidden_size,
            name: model_path.file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "unknown".to_string()),
            max_tokens: 512,
        })
    }

    /// Mean pooling over token embeddings (excluding padding).
    fn mean_pool(embeddings: &Tensor, attention_mask: &Tensor) -> Result<Tensor, candle_core::Error> {
        let mask = attention_mask.unsqueeze(2)?.to_dtype(embeddings.dtype())?;
        let masked = embeddings.broadcast_mul(&mask)?;
        let sum = masked.sum(1)?;
        let count = mask.sum(1)?.clamp(1e-9, f64::MAX)?;
        sum.broadcast_div(&count)
    }
}

#[async_trait]
impl EmbeddingModel for LocalEmbeddingModel {
    fn dimensions(&self) -> usize { self.dim }
    fn model_name(&self) -> &str { &self.name }

    async fn embed(&self, text: &str) -> Result<Vec<f32>, EmbeddingError> {
        let encoding = self.tokenizer.encode(text, true)
            .map_err(|e| EmbeddingError::Inference(format!("tokenize: {e}")))?;

        let input_ids = Tensor::new(encoding.get_ids(), &self.device)
            .map_err(|e| EmbeddingError::Inference(e.to_string()))?
            .unsqueeze(0)
            .map_err(|e| EmbeddingError::Inference(e.to_string()))?;

        let attention_mask = Tensor::new(encoding.get_attention_mask(), &self.device)
            .map_err(|e| EmbeddingError::Inference(e.to_string()))?
            .unsqueeze(0)
            .map_err(|e| EmbeddingError::Inference(e.to_string()))?;

        let token_type_ids = Tensor::zeros_like(&input_ids)
            .map_err(|e| EmbeddingError::Inference(e.to_string()))?;

        let embeddings = self.model.forward(&input_ids, &token_type_ids, Some(&attention_mask))
            .map_err(|e| EmbeddingError::Inference(e.to_string()))?;

        let pooled = Self::mean_pool(&embeddings, &attention_mask)
            .map_err(|e| EmbeddingError::Inference(e.to_string()))?;

        // L2 normalize
        let norm = pooled.sqr()
            .and_then(|s| s.sum(1))
            .and_then(|s| s.sqrt())
            .and_then(|s| s.clamp(1e-12, f64::MAX))
            .map_err(|e| EmbeddingError::Inference(e.to_string()))?;

        let normalized = pooled.broadcast_div(&norm.unsqueeze(1)
            .map_err(|e| EmbeddingError::Inference(e.to_string()))?)
            .map_err(|e| EmbeddingError::Inference(e.to_string()))?;

        let vec: Vec<f32> = normalized.squeeze(0)
            .map_err(|e| EmbeddingError::Inference(e.to_string()))?
            .to_vec1()
            .map_err(|e| EmbeddingError::Inference(e.to_string()))?;

        Ok(vec)
    }

    async fn embed_batch(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>, EmbeddingError> {
        // For local models, process sequentially to avoid OOM.
        // GPU-backed models can parallelize via padding + batched forward.
        let mut results = Vec::with_capacity(texts.len());
        for text in texts {
            results.push(self.embed(text).await?);
        }
        Ok(results)
    }
}
```

### Remote Embedding Adapter (OpenAI-Compatible)

```rust
use reqwest::Client;
use serde::{Deserialize, Serialize};

/// Remote embedding model — calls an OpenAI-compatible API.
/// Works with OpenAI, Azure OpenAI, Ollama, vLLM, and any
/// server implementing the /v1/embeddings endpoint.
pub struct RemoteEmbeddingModel {
    client: Client,
    base_url: String,
    api_key: String,
    model: String,
    dim: usize,
    max_batch: usize,
}

#[derive(Serialize)]
struct EmbeddingRequest<'a> {
    model: &'a str,
    input: Vec<&'a str>,
    encoding_format: &'a str,
}

#[derive(Deserialize)]
struct EmbeddingResponse {
    data: Vec<EmbeddingData>,
}

#[derive(Deserialize)]
struct EmbeddingData {
    embedding: Vec<f32>,
    index: usize,
}

impl RemoteEmbeddingModel {
    pub fn new(
        base_url: String,
        api_key: String,
        model: String,
        dim: usize,
    ) -> Self {
        Self {
            client: Client::new(),
            base_url,
            api_key,
            model,
            dim,
            max_batch: 100,
        }
    }
}

#[async_trait]
impl EmbeddingModel for RemoteEmbeddingModel {
    fn dimensions(&self) -> usize { self.dim }
    fn model_name(&self) -> &str { &self.model }

    async fn embed(&self, text: &str) -> Result<Vec<f32>, EmbeddingError> {
        let mut results = self.embed_batch(&[text]).await?;
        results.pop().ok_or_else(|| EmbeddingError::Inference("empty response".into()))
    }

    async fn embed_batch(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>, EmbeddingError> {
        if texts.len() > self.max_batch {
            return Err(EmbeddingError::BatchTooLarge {
                size: texts.len(),
                max: self.max_batch,
            });
        }

        let request = EmbeddingRequest {
            model: &self.model,
            input: texts.to_vec(),
            encoding_format: "float",
        };

        let response = self.client
            .post(format!("{}/v1/embeddings", self.base_url))
            .header("Authorization", format!("Bearer {}", self.api_key))
            .json(&request)
            .send()
            .await?
            .error_for_status()
            .map_err(|e| EmbeddingError::Inference(format!("API error: {e}")))?
            .json::<EmbeddingResponse>()
            .await?;

        // Sort by index to maintain input order
        let mut data = response.data;
        data.sort_by_key(|d| d.index);

        Ok(data.into_iter().map(|d| d.embedding).collect())
    }
}
```

### Auto-Embed Pipeline

For tables with EMBEDDING columns, automatically generate embeddings on INSERT. The write is acknowledged immediately; embedding generation runs asynchronously in the background.

```rust
use tokio::sync::mpsc;

/// Embedding job: vector ID + text to embed.
struct EmbedJob {
    vector_id: u32,
    text: String,
}

/// Background embedding pipeline. Batches pending texts, generates embeddings,
/// writes vectors to storage, and updates the HNSW index.
pub struct EmbedPipeline {
    tx: mpsc::Sender<EmbedJob>,
}

impl EmbedPipeline {
    /// Start the background embedding pipeline.
    /// `batch_size` controls how many texts are batched per API call.
    /// `flush_interval` controls the maximum wait before flushing a partial batch.
    pub fn start(
        model: Box<dyn EmbeddingModel>,
        vector_path: std::path::PathBuf,
        hnsw: std::sync::Arc<std::sync::RwLock<HnswIndex>>,
        vectors: std::sync::Arc<VectorStorage>,
        batch_size: usize,
        flush_interval: std::time::Duration,
    ) -> Self {
        let (tx, mut rx) = mpsc::channel::<EmbedJob>(10_000);

        tokio::spawn(async move {
            let mut batch: Vec<EmbedJob> = Vec::with_capacity(batch_size);
            let mut interval = tokio::time::interval(flush_interval);

            loop {
                tokio::select! {
                    Some(job) = rx.recv() => {
                        batch.push(job);
                        if batch.len() >= batch_size {
                            process_batch(&model, &vector_path, &hnsw, &vectors, &mut batch).await;
                        }
                    }
                    _ = interval.tick() => {
                        if !batch.is_empty() {
                            process_batch(&model, &vector_path, &hnsw, &vectors, &mut batch).await;
                        }
                    }
                }
            }
        });

        Self { tx }
    }

    /// Queue a text for background embedding. Returns immediately.
    pub async fn enqueue(&self, vector_id: u32, text: String) -> Result<(), EmbeddingError> {
        self.tx.send(EmbedJob { vector_id, text }).await
            .map_err(|_| EmbeddingError::Inference("pipeline closed".into()))
    }
}

async fn process_batch(
    model: &dyn EmbeddingModel,
    vector_path: &std::path::Path,
    hnsw: &std::sync::Arc<std::sync::RwLock<HnswIndex>>,
    vectors: &std::sync::Arc<VectorStorage>,
    batch: &mut Vec<EmbedJob>,
) {
    let texts: Vec<&str> = batch.iter().map(|j| j.text.as_str()).collect();

    match model.embed_batch(&texts).await {
        Ok(embeddings) => {
            for (job, embedding) in batch.iter().zip(embeddings.iter()) {
                // Append vector to storage file
                if let Err(e) = VectorStorage::append(vector_path, embedding) {
                    eprintln!("failed to write vector {}: {e}", job.vector_id);
                    continue;
                }

                // Insert into HNSW index
                let mut index = hnsw.write().unwrap();
                index.insert(job.vector_id, vectors);
            }
        }
        Err(e) => {
            eprintln!("batch embedding failed: {e}");
            // In production: retry with exponential backoff, dead-letter queue
        }
    }

    batch.clear();
}
```

---

## Never

- **Never block tokio with SIMD computation.** Distance functions and HNSW traversal are CPU-bound. Run bulk vector operations on `spawn_blocking` or a dedicated thread pool. Individual query searches (< 10ms) are acceptable on the async runtime.
- **Never use `unsafe` without a `// SAFETY:` comment.** mmap, SIMD intrinsics, and raw pointer casts all require justification of the invariant being upheld.
- **Never assume alignment for mmap'd data.** The vector storage format guarantees f32 alignment because the file is written as contiguous f32 values, but document this assumption at the mmap site.
- **Never skip the tail loop in SIMD kernels.** If the vector dimension is not a multiple of the SIMD lane width (8 for AVX2, 4 for SSE/NEON), the tail elements must be processed with scalar code.
- **Never use `f32::partial_cmp` without handling `NaN`.** Distance functions should never produce NaN (inputs are finite), but guard against it at comparison sites with `.unwrap_or(Ordering::Equal)`.
- **Never mutate the HNSW index without exclusive access.** Reads can be concurrent (`RwLock::read`), but inserts require `RwLock::write`. Concurrent inserts require external serialization or a lock-free insert path.
- **Never train quantization parameters on the query vector.** SQ8/PQ codebooks must be trained on a representative sample of the index vectors, not on query-time data.
