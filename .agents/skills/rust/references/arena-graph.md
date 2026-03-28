# Arena Allocation & Graph Engine

## What

Arena allocation + index-based graph data structures give you a graph engine in safe Rust. Nodes and edges live in contiguous `Vec`s, referenced by typed indices (`NodeIndex`, `EdgeIndex`) instead of pointers or references. The borrow checker is satisfied because indices are `Copy` integers — no lifetimes, no `Rc<RefCell<>>`, no `unsafe`.

### Why Arenas for Graphs

| Problem with `&Node` / `Box<Node>` | Arena + index solution |
|---|---|
| Cyclic references need `Rc<RefCell<>>` or `unsafe` | `NodeIndex(u32)` is `Copy` — store it anywhere |
| Borrow checker fights graph mutations | Mutate `Vec<NodeData>` freely — indices don't borrow |
| Pointer chasing across heap allocations | Contiguous `Vec` — cache-friendly sequential access |
| Per-node deallocation overhead | Drop the `Vec` (or arena) — bulk free everything |
| Lifetime annotations infect the entire API | Indices have no lifetime — pass them across any boundary |

### Key Dependencies

```toml
[dependencies]
bumpalo = "3"    # Bump allocator for batch allocation (optional — Vec-based arenas are often sufficient)

[dev-dependencies]
proptest = "1"   # Property-based testing for graph invariants
```

---

## Arena Allocation with bumpalo

### Basic Usage

```rust
use bumpalo::Bump;

// Create an arena — all allocations are contiguous in memory
let arena = Bump::new();

// Allocate individual values
let x: &mut i32 = arena.alloc(42);
let name: &str = arena.alloc_str("Alice");

// Allocate a slice from an iterator
let ids: &mut [u64] = arena.alloc_slice_copy(&[1, 2, 3, 4, 5]);

// Allocate with a closure (useful when construction needs arena references)
let node: &mut GraphNode = arena.alloc_with(|| GraphNode {
    id: 1,
    label: arena.alloc_str("person"),
    neighbors: bumpalo::vec![in &arena; 2, 3, 5],
});

// Everything freed when `arena` is dropped — single deallocation
```

### Typed Arena Wrapper

When all allocations are the same type, wrap `Bump` for type safety:

```rust
use bumpalo::Bump;
use std::marker::PhantomData;

pub struct TypedArena<T> {
    bump: Bump,
    count: usize,
    _marker: PhantomData<T>,
}

impl<T> TypedArena<T> {
    pub fn new() -> Self {
        Self {
            bump: Bump::new(),
            count: 0,
            _marker: PhantomData,
        }
    }

    /// Allocate a value, return its index.
    pub fn alloc(&mut self, value: T) -> usize {
        let _ = self.bump.alloc(value);
        let idx = self.count;
        self.count += 1;
        idx
    }

    /// Total bytes allocated (useful for memory budgeting).
    pub fn allocated_bytes(&self) -> usize {
        self.bump.allocated_bytes()
    }
}
```

### When to Use bumpalo vs Plain Vec

| Scenario | Use |
|---|---|
| Fixed graph loaded once, queried many times | `Vec<NodeData>` + `Vec<EdgeData>` — simpler, indexable, serializable |
| Temporary graph built during query execution | `bumpalo::Bump` — allocate fast, drop everything when query finishes |
| Mixed-type allocations (nodes, edges, strings, temp buffers) | `bumpalo::Bump` — single arena for heterogeneous types |
| Need `serde` serialization | `Vec`-based — bumpalo allocations are not serializable |

**For the graph storage engine below, we use `Vec`-based arenas.** bumpalo is used for transient query-time allocations (pattern matching intermediate results, traversal buffers).

---

## Graph Data Structures

### Typed Indices (Safe Rust, Zero-Cost)

Instead of pointers, use newtype wrappers around integers. This is the core pattern that makes the entire graph engine safe:

```rust
/// Index into GraphStorage::nodes
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct NodeIndex(pub u32);

/// Index into GraphStorage::edges
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct EdgeIndex(pub u32);

/// Compact label identifier — maps to/from String via LabelRegistry
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct LabelId(pub u16);

impl NodeIndex {
    #[inline]
    pub fn as_usize(self) -> usize {
        self.0 as usize
    }
}

impl EdgeIndex {
    #[inline]
    pub fn as_usize(self) -> usize {
        self.0 as usize
    }
}

// Display for debugging: Node(42), Edge(7)
impl std::fmt::Display for NodeIndex {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Node({})", self.0)
    }
}

impl std::fmt::Display for EdgeIndex {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Edge({})", self.0)
    }
}
```

### Node and Edge Data

```rust
/// Per-node data — kept small for cache efficiency.
/// Properties live in a separate document store (BMAP), referenced by offset.
#[derive(Debug, Clone)]
pub struct NodeData {
    /// Unique node identifier (external-facing, stable across compaction)
    pub id: u64,
    /// Label — Person, Product, etc. Resolved via LabelRegistry.
    pub label_id: LabelId,
    /// Byte offset into the document/property store (BMAP).
    /// Properties are stored externally to keep NodeData small and cache-hot.
    pub properties_offset: u64,
}

/// Per-edge data — directional (from → to).
#[derive(Debug, Clone)]
pub struct EdgeData {
    /// Unique edge identifier
    pub id: u64,
    /// Label — KNOWS, PURCHASED, etc.
    pub label_id: LabelId,
    /// Source node
    pub from: NodeIndex,
    /// Target node
    pub to: NodeIndex,
    /// Byte offset into the document/property store (BMAP).
    pub properties_offset: u64,
}
```

### Label Registry

Bidirectional mapping between human-readable label strings and compact `LabelId` values:

```rust
use std::collections::HashMap;

/// Bidirectional String ↔ LabelId mapping.
/// Labels are interned — each unique string is stored once.
#[derive(Debug, Default)]
pub struct LabelRegistry {
    to_id: HashMap<String, LabelId>,
    to_name: Vec<String>, // indexed by LabelId.0
}

impl LabelRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Get or create a LabelId for the given name.
    pub fn get_or_insert(&mut self, name: &str) -> LabelId {
        if let Some(&id) = self.to_id.get(name) {
            return id;
        }
        let id = LabelId(self.to_name.len() as u16);
        self.to_name.push(name.to_owned());
        self.to_id.insert(name.to_owned(), id);
        id
    }

    /// Resolve a LabelId back to its string name.
    #[must_use]
    pub fn resolve(&self, id: LabelId) -> Option<&str> {
        self.to_name.get(id.0 as usize).map(|s| s.as_str())
    }

    /// Look up by name without inserting.
    #[must_use]
    pub fn lookup(&self, name: &str) -> Option<LabelId> {
        self.to_id.get(name).copied()
    }
}
```

### GraphStorage — The Core

```rust
/// Arena-based graph storage with bidirectional adjacency lists.
///
/// All nodes and edges are stored in contiguous Vec buffers.
/// Adjacency is maintained as sorted Vec<EdgeIndex> per node,
/// for both outgoing and incoming directions.
#[derive(Debug)]
pub struct GraphStorage {
    /// All nodes, indexed by NodeIndex
    nodes: Vec<NodeData>,
    /// All edges, indexed by EdgeIndex
    edges: Vec<EdgeData>,
    /// node → outgoing edges (sorted by EdgeIndex for binary search)
    outgoing: Vec<Vec<EdgeIndex>>,
    /// node → incoming edges (sorted by EdgeIndex for binary search)
    incoming: Vec<Vec<EdgeIndex>>,
    /// External ID → NodeIndex lookup
    node_id_map: HashMap<u64, NodeIndex>,
    /// Label interning
    labels: LabelRegistry,
}

impl GraphStorage {
    pub fn new() -> Self {
        Self {
            nodes: Vec::new(),
            edges: Vec::new(),
            outgoing: Vec::new(),
            incoming: Vec::new(),
            node_id_map: HashMap::new(),
            labels: LabelRegistry::new(),
        }
    }

    /// Pre-allocate capacity for known graph size.
    pub fn with_capacity(node_capacity: usize, edge_capacity: usize) -> Self {
        Self {
            nodes: Vec::with_capacity(node_capacity),
            edges: Vec::with_capacity(edge_capacity),
            outgoing: Vec::with_capacity(node_capacity),
            incoming: Vec::with_capacity(node_capacity),
            node_id_map: HashMap::with_capacity(node_capacity),
            labels: LabelRegistry::new(),
        }
    }

    // --- Node operations ---

    /// Add a node. Returns its NodeIndex.
    pub fn add_node(&mut self, id: u64, label: &str, properties_offset: u64) -> NodeIndex {
        let label_id = self.labels.get_or_insert(label);
        let idx = NodeIndex(self.nodes.len() as u32);
        self.nodes.push(NodeData {
            id,
            label_id,
            properties_offset,
        });
        self.outgoing.push(Vec::new());
        self.incoming.push(Vec::new());
        self.node_id_map.insert(id, idx);
        idx
    }

    /// Look up a node by its external ID.
    #[must_use]
    pub fn node_by_id(&self, id: u64) -> Option<NodeIndex> {
        self.node_id_map.get(&id).copied()
    }

    /// Get node data by index. Panics if out of bounds (debug assertion).
    #[must_use]
    pub fn node(&self, idx: NodeIndex) -> &NodeData {
        debug_assert!(idx.as_usize() < self.nodes.len(), "NodeIndex out of bounds: {idx}");
        &self.nodes[idx.as_usize()]
    }

    /// Total node count.
    #[must_use]
    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }

    /// Iterate all node indices.
    pub fn node_indices(&self) -> impl Iterator<Item = NodeIndex> {
        (0..self.nodes.len() as u32).map(NodeIndex)
    }

    /// Iterate all nodes with label filter.
    pub fn nodes_with_label(&self, label_id: LabelId) -> impl Iterator<Item = NodeIndex> + '_ {
        self.nodes
            .iter()
            .enumerate()
            .filter(move |(_, n)| n.label_id == label_id)
            .map(|(i, _)| NodeIndex(i as u32))
    }

    // --- Edge operations ---

    /// Add a directed edge. Returns its EdgeIndex.
    /// Maintains bidirectional adjacency (outgoing from `from`, incoming to `to`).
    pub fn add_edge(
        &mut self,
        id: u64,
        label: &str,
        from: NodeIndex,
        to: NodeIndex,
        properties_offset: u64,
    ) -> EdgeIndex {
        debug_assert!(from.as_usize() < self.nodes.len(), "from NodeIndex out of bounds: {from}");
        debug_assert!(to.as_usize() < self.nodes.len(), "to NodeIndex out of bounds: {to}");

        let label_id = self.labels.get_or_insert(label);
        let idx = EdgeIndex(self.edges.len() as u32);
        self.edges.push(EdgeData {
            id,
            label_id,
            from,
            to,
            properties_offset,
        });
        self.outgoing[from.as_usize()].push(idx);
        self.incoming[to.as_usize()].push(idx);
        idx
    }

    /// Get edge data by index.
    #[must_use]
    pub fn edge(&self, idx: EdgeIndex) -> &EdgeData {
        debug_assert!(idx.as_usize() < self.edges.len(), "EdgeIndex out of bounds: {idx}");
        &self.edges[idx.as_usize()]
    }

    /// Total edge count.
    #[must_use]
    pub fn edge_count(&self) -> usize {
        self.edges.len()
    }

    // --- Adjacency queries ---

    /// Outgoing edges from a node.
    #[must_use]
    pub fn outgoing_edges(&self, node: NodeIndex) -> &[EdgeIndex] {
        &self.outgoing[node.as_usize()]
    }

    /// Incoming edges to a node.
    #[must_use]
    pub fn incoming_edges(&self, node: NodeIndex) -> &[EdgeIndex] {
        &self.incoming[node.as_usize()]
    }

    /// Outgoing neighbors (target nodes of outgoing edges).
    pub fn outgoing_neighbors(&self, node: NodeIndex) -> impl Iterator<Item = NodeIndex> + '_ {
        self.outgoing[node.as_usize()]
            .iter()
            .map(|&eidx| self.edges[eidx.as_usize()].to)
    }

    /// Incoming neighbors (source nodes of incoming edges).
    pub fn incoming_neighbors(&self, node: NodeIndex) -> impl Iterator<Item = NodeIndex> + '_ {
        self.incoming[node.as_usize()]
            .iter()
            .map(|&eidx| self.edges[eidx.as_usize()].from)
    }

    /// All neighbors (both directions), deduplicated.
    pub fn all_neighbors(&self, node: NodeIndex) -> Vec<NodeIndex> {
        let mut neighbors: Vec<NodeIndex> = self
            .outgoing_neighbors(node)
            .chain(self.incoming_neighbors(node))
            .collect();
        neighbors.sort_unstable();
        neighbors.dedup();
        neighbors
    }

    /// Outgoing edges filtered by label.
    pub fn outgoing_edges_with_label(
        &self,
        node: NodeIndex,
        label_id: LabelId,
    ) -> impl Iterator<Item = EdgeIndex> + '_ {
        self.outgoing[node.as_usize()]
            .iter()
            .copied()
            .filter(move |&eidx| self.edges[eidx.as_usize()].label_id == label_id)
    }

    /// Access the label registry.
    #[must_use]
    pub fn labels(&self) -> &LabelRegistry {
        &self.labels
    }

    /// Mutable access to the label registry.
    pub fn labels_mut(&mut self) -> &mut LabelRegistry {
        &mut self.labels
    }

    // --- Deletion ---

    /// Remove an edge by marking it as deleted (tombstone).
    /// Does NOT compact — adjacency lists retain the EdgeIndex but it is skipped in iteration.
    /// Call `compact()` periodically to reclaim space.
    pub fn remove_edge(&mut self, idx: EdgeIndex) {
        let edge = &self.edges[idx.as_usize()];
        let from = edge.from;
        let to = edge.to;
        self.outgoing[from.as_usize()].retain(|&e| e != idx);
        self.incoming[to.as_usize()].retain(|&e| e != idx);
        // Tombstone: set from == to == NodeIndex(u32::MAX)
        let edge = &mut self.edges[idx.as_usize()];
        edge.from = NodeIndex(u32::MAX);
        edge.to = NodeIndex(u32::MAX);
    }

    /// Check if an edge is a tombstone (deleted).
    #[must_use]
    pub fn is_edge_deleted(&self, idx: EdgeIndex) -> bool {
        self.edges[idx.as_usize()].from == NodeIndex(u32::MAX)
    }
}
```

### AS NODE / AS EDGE Table Annotations

When SQL tables are annotated as graph elements, the engine auto-creates adjacency:

```rust
/// Declares how a SQL table maps to the graph overlay.
#[derive(Debug, Clone)]
pub struct GraphAnnotation {
    pub table_name: String,
    pub annotation_type: GraphAnnotationType,
}

#[derive(Debug, Clone)]
pub enum GraphAnnotationType {
    /// `CREATE TABLE people (...) AS NODE`
    /// Each row becomes a graph node. Row PK = node external ID.
    Node,
    /// `CREATE TABLE knows (...) AS EDGE FROM people TO people`
    /// Each row becomes an edge. Auto-adds `from_id` and `to_id` columns.
    Edge {
        from_table: String,
        to_table: String,
    },
}

/// Tracks all graph-annotated tables and syncs them with GraphStorage.
#[derive(Debug)]
pub struct GraphCatalog {
    annotations: Vec<GraphAnnotation>,
    /// Maps table_name → LabelId for quick lookup during WAL apply.
    table_to_label: HashMap<String, LabelId>,
}

impl GraphCatalog {
    pub fn new() -> Self {
        Self {
            annotations: Vec::new(),
            table_to_label: HashMap::new(),
        }
    }

    /// Register a table as a graph node source.
    /// After this call, INSERT into this table also creates a graph node.
    pub fn register_node_table(
        &mut self,
        table_name: &str,
        graph: &mut GraphStorage,
    ) {
        let label_id = graph.labels_mut().get_or_insert(table_name);
        self.annotations.push(GraphAnnotation {
            table_name: table_name.to_owned(),
            annotation_type: GraphAnnotationType::Node,
        });
        self.table_to_label.insert(table_name.to_owned(), label_id);
    }

    /// Register a table as a graph edge source.
    /// The table must have `from_id` and `to_id` columns referencing node tables.
    pub fn register_edge_table(
        &mut self,
        table_name: &str,
        from_table: &str,
        to_table: &str,
        graph: &mut GraphStorage,
    ) {
        let label_id = graph.labels_mut().get_or_insert(table_name);
        self.annotations.push(GraphAnnotation {
            table_name: table_name.to_owned(),
            annotation_type: GraphAnnotationType::Edge {
                from_table: from_table.to_owned(),
                to_table: to_table.to_owned(),
            },
        });
        self.table_to_label.insert(table_name.to_owned(), label_id);
    }
}
```

---

## Traversal Algorithms

All traversal functions take `&GraphStorage` (immutable borrow) — they never mutate the graph.

### BFS (Breadth-First Search)

```rust
use std::collections::VecDeque;

/// Breadth-first traversal from `start`, up to `max_depth` hops.
/// Returns visited nodes with their depth from start.
/// Optionally filters by edge label.
#[must_use]
pub fn bfs(
    graph: &GraphStorage,
    start: NodeIndex,
    max_depth: usize,
    edge_label_filter: Option<LabelId>,
) -> Vec<(NodeIndex, usize)> {
    let node_count = graph.node_count();
    let mut visited = vec![false; node_count];
    let mut result = Vec::new();
    let mut queue = VecDeque::new();

    visited[start.as_usize()] = true;
    queue.push_back((start, 0usize));
    result.push((start, 0));

    while let Some((current, depth)) = queue.pop_front() {
        if depth >= max_depth {
            continue;
        }

        let edges = graph.outgoing_edges(current);
        for &edge_idx in edges {
            let edge = graph.edge(edge_idx);

            // Skip if label filter is set and doesn't match
            if let Some(filter_label) = edge_label_filter {
                if edge.label_id != filter_label {
                    continue;
                }
            }

            let neighbor = edge.to;
            if !visited[neighbor.as_usize()] {
                visited[neighbor.as_usize()] = true;
                let next_depth = depth + 1;
                result.push((neighbor, next_depth));
                queue.push_back((neighbor, next_depth));
            }
        }
    }

    result
}
```

### DFS (Depth-First Search) — Iterative

Iterative with explicit stack to avoid stack overflow on deep graphs:

```rust
/// Iterative depth-first traversal. Returns nodes in DFS visit order.
/// Uses an explicit stack — safe for graphs with millions of nodes.
#[must_use]
pub fn dfs(
    graph: &GraphStorage,
    start: NodeIndex,
    max_depth: usize,
    edge_label_filter: Option<LabelId>,
) -> Vec<(NodeIndex, usize)> {
    let node_count = graph.node_count();
    let mut visited = vec![false; node_count];
    let mut result = Vec::new();
    let mut stack = Vec::new();

    stack.push((start, 0usize));

    while let Some((current, depth)) = stack.pop() {
        if visited[current.as_usize()] {
            continue;
        }
        visited[current.as_usize()] = true;
        result.push((current, depth));

        if depth >= max_depth {
            continue;
        }

        // Push neighbors in reverse order so that the first neighbor is visited first
        let edges = graph.outgoing_edges(current);
        for &edge_idx in edges.iter().rev() {
            let edge = graph.edge(edge_idx);

            if let Some(filter_label) = edge_label_filter {
                if edge.label_id != filter_label {
                    continue;
                }
            }

            let neighbor = edge.to;
            if !visited[neighbor.as_usize()] {
                stack.push((neighbor, depth + 1));
            }
        }
    }

    result
}
```

### Shortest Path (Dijkstra)

```rust
use std::cmp::Ordering;
use std::collections::BinaryHeap;

/// State for Dijkstra's priority queue.
/// Implements Ord to give us a min-heap (BinaryHeap is max-heap by default).
#[derive(Debug)]
struct DijkstraState {
    cost: f64,
    node: NodeIndex,
}

impl PartialEq for DijkstraState {
    fn eq(&self, other: &Self) -> bool {
        self.cost.to_bits() == other.cost.to_bits() && self.node == other.node
    }
}
impl Eq for DijkstraState {}

impl PartialOrd for DijkstraState {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for DijkstraState {
    fn cmp(&self, other: &Self) -> Ordering {
        // Reverse ordering for min-heap behavior
        other
            .cost
            .partial_cmp(&self.cost)
            .unwrap_or(Ordering::Equal)
            .then_with(|| self.node.0.cmp(&other.node.0))
    }
}

/// Dijkstra's shortest path from `from` to `to`.
/// `weight_fn` extracts the edge weight (must be non-negative).
/// Returns (total_cost, path) or None if unreachable.
#[must_use]
pub fn shortest_path(
    graph: &GraphStorage,
    from: NodeIndex,
    to: NodeIndex,
    weight_fn: impl Fn(&EdgeData) -> f64,
) -> Option<(f64, Vec<NodeIndex>)> {
    let node_count = graph.node_count();
    let mut dist = vec![f64::INFINITY; node_count];
    let mut prev: Vec<Option<NodeIndex>> = vec![None; node_count];
    let mut heap = BinaryHeap::new();

    dist[from.as_usize()] = 0.0;
    heap.push(DijkstraState {
        cost: 0.0,
        node: from,
    });

    while let Some(DijkstraState { cost, node }) = heap.pop() {
        // Found the target — reconstruct path
        if node == to {
            let mut path = Vec::new();
            let mut current = Some(to);
            while let Some(n) = current {
                path.push(n);
                current = prev[n.as_usize()];
            }
            path.reverse();
            return Some((cost, path));
        }

        // Skip if we already found a shorter path to this node
        if cost > dist[node.as_usize()] {
            continue;
        }

        for &edge_idx in graph.outgoing_edges(node) {
            let edge = graph.edge(edge_idx);
            let weight = weight_fn(edge);
            debug_assert!(weight >= 0.0, "Dijkstra requires non-negative weights");

            let next_cost = cost + weight;
            let neighbor = edge.to;

            if next_cost < dist[neighbor.as_usize()] {
                dist[neighbor.as_usize()] = next_cost;
                prev[neighbor.as_usize()] = Some(node);
                heap.push(DijkstraState {
                    cost: next_cost,
                    node: neighbor,
                });
            }
        }
    }

    None // Target unreachable
}
```

### PageRank

```rust
/// Iterative PageRank computation.
///
/// - `damping`: probability of following a link (typically 0.85)
/// - `tolerance`: convergence threshold (typically 1e-6)
/// - `max_iterations`: safety cap to prevent infinite loops
///
/// Returns a Vec of scores indexed by NodeIndex.
#[must_use]
pub fn pagerank(
    graph: &GraphStorage,
    damping: f64,
    tolerance: f64,
    max_iterations: usize,
) -> Vec<f64> {
    let n = graph.node_count();
    if n == 0 {
        return Vec::new();
    }

    let initial_score = 1.0 / n as f64;
    let mut scores = vec![initial_score; n];
    let mut new_scores = vec![0.0f64; n];

    // Precompute out-degree for each node
    let out_degree: Vec<usize> = (0..n)
        .map(|i| graph.outgoing_edges(NodeIndex(i as u32)).len())
        .collect();

    for _iteration in 0..max_iterations {
        // Reset new scores to the random-jump baseline
        new_scores.fill((1.0 - damping) / n as f64);

        // Distribute scores along edges
        for i in 0..n {
            let deg = out_degree[i];
            if deg == 0 {
                // Dangling node — distribute its score evenly to all nodes
                let share = damping * scores[i] / n as f64;
                for s in new_scores.iter_mut() {
                    *s += share;
                }
            } else {
                let share = damping * scores[i] / deg as f64;
                for &edge_idx in graph.outgoing_edges(NodeIndex(i as u32)) {
                    let target = graph.edge(edge_idx).to.as_usize();
                    new_scores[target] += share;
                }
            }
        }

        // Check convergence (L1 norm of difference)
        let diff: f64 = scores
            .iter()
            .zip(new_scores.iter())
            .map(|(old, new)| (old - new).abs())
            .sum();

        std::mem::swap(&mut scores, &mut new_scores);

        if diff < tolerance {
            break;
        }
    }

    scores
}
```

### Connected Components (Union-Find)

```rust
/// Disjoint-set (Union-Find) with path compression and union by rank.
/// Used for connected component detection.
pub struct UnionFind {
    parent: Vec<u32>,
    rank: Vec<u8>,
}

impl UnionFind {
    pub fn new(size: usize) -> Self {
        Self {
            parent: (0..size as u32).collect(),
            rank: vec![0; size],
        }
    }

    /// Find the root of the set containing `x`, with path compression.
    pub fn find(&mut self, x: u32) -> u32 {
        if self.parent[x as usize] != x {
            self.parent[x as usize] = self.find(self.parent[x as usize]);
        }
        self.parent[x as usize]
    }

    /// Union the sets containing `x` and `y`. Returns true if they were separate.
    pub fn union(&mut self, x: u32, y: u32) -> bool {
        let rx = self.find(x);
        let ry = self.find(y);
        if rx == ry {
            return false;
        }
        // Union by rank — attach shorter tree under taller tree
        match self.rank[rx as usize].cmp(&self.rank[ry as usize]) {
            std::cmp::Ordering::Less => self.parent[rx as usize] = ry,
            std::cmp::Ordering::Greater => self.parent[ry as usize] = rx,
            std::cmp::Ordering::Equal => {
                self.parent[ry as usize] = rx;
                self.rank[rx as usize] += 1;
            }
        }
        true
    }
}

/// Find all connected components (treating edges as undirected).
/// Returns a map from component root → list of node indices.
#[must_use]
pub fn connected_components(graph: &GraphStorage) -> HashMap<u32, Vec<NodeIndex>> {
    let n = graph.node_count();
    let mut uf = UnionFind::new(n);

    // Union all edges (both directions — treating as undirected)
    for i in 0..n {
        let node = NodeIndex(i as u32);
        for &edge_idx in graph.outgoing_edges(node) {
            let edge = graph.edge(edge_idx);
            uf.union(node.0, edge.to.0);
        }
    }

    // Group nodes by their component root
    let mut components: HashMap<u32, Vec<NodeIndex>> = HashMap::new();
    for i in 0..n as u32 {
        let root = uf.find(i);
        components.entry(root).or_default().push(NodeIndex(i));
    }

    components
}
```

### Variable-Length Path Traversal

Used by graph pattern matching — traverse 1..N hops following a label:

```rust
/// Traverse variable-length paths: from `start`, follow edges with `label_id`
/// between `min_hops` and `max_hops` times.
/// Returns all reachable (node, hop_count) pairs.
#[must_use]
pub fn variable_length_traverse(
    graph: &GraphStorage,
    start: NodeIndex,
    label_id: LabelId,
    min_hops: usize,
    max_hops: usize,
) -> Vec<(NodeIndex, usize)> {
    let node_count = graph.node_count();
    let mut results = Vec::new();
    // (current_node, depth, visited_set_as_bitmask_or_hashset)
    let mut stack: Vec<(NodeIndex, usize, Vec<bool>)> = Vec::new();

    let mut initial_visited = vec![false; node_count];
    initial_visited[start.as_usize()] = true;
    stack.push((start, 0, initial_visited));

    while let Some((current, depth, visited)) = stack.pop() {
        // Collect if within hop range
        if depth >= min_hops {
            results.push((current, depth));
        }

        if depth >= max_hops {
            continue;
        }

        // Follow matching edges
        for &edge_idx in graph.outgoing_edges(current) {
            let edge = graph.edge(edge_idx);
            if edge.label_id != label_id {
                continue;
            }
            let neighbor = edge.to;
            if !visited[neighbor.as_usize()] {
                let mut next_visited = visited.clone();
                next_visited[neighbor.as_usize()] = true;
                stack.push((neighbor, depth + 1, next_visited));
            }
        }
    }

    results
}
```

---

## Cypher-Lite Pattern Matching

### Pattern AST

```rust
/// Direction of an edge in a pattern.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EdgeDirection {
    /// `-[r:LABEL]->` — left to right
    Outgoing,
    /// `<-[r:LABEL]-` — right to left
    Incoming,
    /// `-[r:LABEL]-` — either direction
    Both,
}

/// A single element in a graph pattern.
#[derive(Debug, Clone)]
pub enum PatternElement {
    Node {
        variable: String,
        label: Option<String>,
    },
    Edge {
        variable: String,
        label: Option<String>,
        direction: EdgeDirection,
        /// Variable-length: (min_hops, max_hops). None = exactly 1 hop.
        hops: Option<(usize, usize)>,
    },
}

/// A complete pattern: alternating Node, Edge, Node, Edge, ..., Node.
#[derive(Debug, Clone)]
pub struct GraphPattern {
    pub elements: Vec<PatternElement>,
}

/// A single row of pattern match results — variable name → NodeIndex or EdgeIndex.
#[derive(Debug, Clone)]
pub struct MatchBinding {
    pub nodes: HashMap<String, NodeIndex>,
    pub edges: HashMap<String, EdgeIndex>,
}
```

### Compilation to Traversal Plan

A pattern compiles into a sequence of traversal steps:

```rust
/// A step in the traversal plan.
#[derive(Debug)]
pub enum TraversalStep {
    /// Start from nodes matching a label (and optional WHERE predicate).
    ScanNodes {
        variable: String,
        label_id: Option<LabelId>,
    },
    /// Follow edges from the previous node in the pattern.
    FollowEdges {
        edge_variable: String,
        edge_label_id: Option<LabelId>,
        direction: EdgeDirection,
        target_variable: String,
        target_label_id: Option<LabelId>,
        hops: Option<(usize, usize)>,
    },
}

/// Compile a GraphPattern into a TraversalPlan.
pub fn compile_pattern(
    pattern: &GraphPattern,
    labels: &LabelRegistry,
) -> Vec<TraversalStep> {
    let mut steps = Vec::new();
    let mut i = 0;

    while i < pattern.elements.len() {
        match &pattern.elements[i] {
            PatternElement::Node { variable, label } if i == 0 => {
                // First node — this is a scan
                let label_id = label
                    .as_ref()
                    .and_then(|l| labels.lookup(l));
                steps.push(TraversalStep::ScanNodes {
                    variable: variable.clone(),
                    label_id,
                });
                i += 1;
            }
            PatternElement::Edge {
                variable: edge_var,
                label: edge_label,
                direction,
                hops,
            } => {
                // Edge must be followed by a target node
                let edge_label_id = edge_label
                    .as_ref()
                    .and_then(|l| labels.lookup(l));

                let (target_var, target_label_id) =
                    if let Some(PatternElement::Node { variable, label }) =
                        pattern.elements.get(i + 1)
                    {
                        let lid = label.as_ref().and_then(|l| labels.lookup(l));
                        (variable.clone(), lid)
                    } else {
                        panic!("Edge must be followed by a Node in pattern");
                    };

                steps.push(TraversalStep::FollowEdges {
                    edge_variable: edge_var.clone(),
                    edge_label_id,
                    direction: direction.clone(),
                    target_variable: target_var,
                    target_label_id,
                    hops: *hops,
                });
                i += 2; // skip edge + target node
            }
            _ => {
                i += 1;
            }
        }
    }

    steps
}
```

### Pattern Execution Engine

```rust
/// Execute a compiled traversal plan against the graph.
/// Returns all bindings (variable → index mappings) that satisfy the pattern.
pub fn execute_pattern(
    graph: &GraphStorage,
    steps: &[TraversalStep],
) -> Vec<MatchBinding> {
    let mut bindings: Vec<MatchBinding> = Vec::new();

    for step in steps {
        match step {
            TraversalStep::ScanNodes { variable, label_id } => {
                // Initial scan — create a binding for each matching node
                let iter: Box<dyn Iterator<Item = NodeIndex>> = match label_id {
                    Some(lid) => Box::new(graph.nodes_with_label(*lid)),
                    None => Box::new(graph.node_indices()),
                };

                for node_idx in iter {
                    let mut binding = MatchBinding {
                        nodes: HashMap::new(),
                        edges: HashMap::new(),
                    };
                    binding.nodes.insert(variable.clone(), node_idx);
                    bindings.push(binding);
                }
            }

            TraversalStep::FollowEdges {
                edge_variable,
                edge_label_id,
                direction,
                target_variable,
                target_label_id,
                hops: None, // single hop
            } => {
                let mut new_bindings = Vec::new();

                for binding in &bindings {
                    // Find the source node from the previous step
                    // It's the last node variable added
                    let source_idx = binding
                        .nodes
                        .values()
                        .last()
                        .copied()
                        .expect("No source node in binding");

                    let edge_list = match direction {
                        EdgeDirection::Outgoing => graph.outgoing_edges(source_idx),
                        EdgeDirection::Incoming => graph.incoming_edges(source_idx),
                        EdgeDirection::Both => {
                            // For Both, we handle outgoing here, incoming below
                            graph.outgoing_edges(source_idx)
                        }
                    };

                    for &eidx in edge_list {
                        let edge = graph.edge(eidx);

                        // Label filter on edge
                        if let Some(filter_lid) = edge_label_id {
                            if edge.label_id != *filter_lid {
                                continue;
                            }
                        }

                        let target = match direction {
                            EdgeDirection::Outgoing | EdgeDirection::Both => edge.to,
                            EdgeDirection::Incoming => edge.from,
                        };

                        // Label filter on target node
                        if let Some(filter_lid) = target_label_id {
                            if graph.node(target).label_id != *filter_lid {
                                continue;
                            }
                        }

                        let mut new_binding = binding.clone();
                        new_binding.edges.insert(edge_variable.clone(), eidx);
                        new_binding.nodes.insert(target_variable.clone(), target);
                        new_bindings.push(new_binding);
                    }

                    // Handle incoming edges for Both direction
                    if *direction == EdgeDirection::Both {
                        for &eidx in graph.incoming_edges(source_idx) {
                            let edge = graph.edge(eidx);
                            if let Some(filter_lid) = edge_label_id {
                                if edge.label_id != *filter_lid {
                                    continue;
                                }
                            }
                            let target = edge.from;
                            if let Some(filter_lid) = target_label_id {
                                if graph.node(target).label_id != *filter_lid {
                                    continue;
                                }
                            }
                            let mut new_binding = binding.clone();
                            new_binding.edges.insert(edge_variable.clone(), eidx);
                            new_binding.nodes.insert(target_variable.clone(), target);
                            new_bindings.push(new_binding);
                        }
                    }
                }

                bindings = new_bindings;
            }

            TraversalStep::FollowEdges { hops: Some(_), .. } => {
                // Variable-length path matching — delegate to variable_length_traverse
                // and expand bindings accordingly.
                // Implementation left to the specific query engine.
                todo!("Variable-length path execution");
            }
        }
    }

    bindings
}
```

### SQL Interop

The same data is queryable via both graph syntax and standard SQL JOINs:

```sql
-- Graph syntax (Cypher-lite)
MATCH (a:people)-[k:knows]->(b:people)
WHERE a.name = 'Alice'
RETURN b.name;

-- Equivalent SQL (auto-generated from AS NODE / AS EDGE declarations)
SELECT b.name
FROM people a
JOIN knows k ON k.from_id = a.id
JOIN people b ON k.to_id = b.id
WHERE a.name = 'Alice';
```

The graph engine does NOT replace SQL — it provides an alternative syntax that compiles to the same execution plan. When a table is declared `AS EDGE FROM people TO people`, the system:

1. Auto-adds `from_id BIGINT NOT NULL` and `to_id BIGINT NOT NULL` columns
2. Creates foreign key constraints to the referenced node tables
3. Builds the adjacency list index (`GraphStorage.outgoing` / `GraphStorage.incoming`)
4. Maintains adjacency on every INSERT/UPDATE/DELETE via WAL hooks

---

## WAL Integration

Graph index updates are derived from WAL (Write-Ahead Log) entries. The graph index is a secondary index — the source of truth is the relational tables.

```rust
/// WAL entry types that affect the graph index.
#[derive(Debug)]
pub enum WalGraphOp {
    /// Row inserted into a node table
    InsertNode {
        table: String,
        row_id: u64,
        properties_offset: u64,
    },
    /// Row inserted into an edge table
    InsertEdge {
        table: String,
        edge_id: u64,
        from_id: u64,
        to_id: u64,
        properties_offset: u64,
    },
    /// Row deleted from a node table
    DeleteNode {
        table: String,
        row_id: u64,
    },
    /// Row deleted from an edge table
    DeleteEdge {
        table: String,
        edge_id: u64,
    },
}

/// Apply a WAL entry to the graph index.
/// Called synchronously during WAL apply — must be fast.
pub fn apply_wal_op(
    graph: &mut GraphStorage,
    catalog: &GraphCatalog,
    op: &WalGraphOp,
) -> Result<(), GraphError> {
    match op {
        WalGraphOp::InsertNode {
            table,
            row_id,
            properties_offset,
        } => {
            graph.add_node(*row_id, table, *properties_offset);
            Ok(())
        }

        WalGraphOp::InsertEdge {
            table,
            edge_id,
            from_id,
            to_id,
            properties_offset,
        } => {
            let from_idx = graph
                .node_by_id(*from_id)
                .ok_or(GraphError::NodeNotFound(*from_id))?;
            let to_idx = graph
                .node_by_id(*to_id)
                .ok_or(GraphError::NodeNotFound(*to_id))?;
            graph.add_edge(*edge_id, table, from_idx, to_idx, *properties_offset);
            Ok(())
        }

        WalGraphOp::DeleteNode { row_id, .. } => {
            // Remove all edges connected to this node first
            if let Some(node_idx) = graph.node_by_id(*row_id) {
                let outgoing: Vec<EdgeIndex> =
                    graph.outgoing_edges(node_idx).to_vec();
                let incoming: Vec<EdgeIndex> =
                    graph.incoming_edges(node_idx).to_vec();
                for eidx in outgoing.into_iter().chain(incoming) {
                    graph.remove_edge(eidx);
                }
                // Mark node as deleted (tombstone)
                // Full removal happens during compaction
            }
            Ok(())
        }

        WalGraphOp::DeleteEdge { edge_id, .. } => {
            // Linear scan for edge by ID — in production, maintain an edge_id_map
            // similar to node_id_map for O(1) lookup.
            // Omitted here for clarity; the pattern is identical to node_id_map.
            Ok(())
        }
    }
}

/// Error types for graph operations.
#[derive(Debug, thiserror::Error)]
pub enum GraphError {
    #[error("Node not found: {0}")]
    NodeNotFound(u64),

    #[error("Edge not found: {0}")]
    EdgeNotFound(u64),

    #[error("Label not found: {0}")]
    LabelNotFound(String),

    #[error("Invalid pattern: {0}")]
    InvalidPattern(String),
}
```

### WAL Sync Guarantees

| Operation | Graph index update | Timing |
|---|---|---|
| `INSERT INTO people (...)` | `add_node()` into adjacency | Synchronous on WAL apply |
| `INSERT INTO knows (...)` | `add_edge()` — updates both `outgoing` and `incoming` | Synchronous on WAL apply |
| `DELETE FROM knows WHERE ...` | `remove_edge()` — tombstones the edge, removes from adjacency | Synchronous on WAL apply |
| `DELETE FROM people WHERE ...` | Remove all connected edges, then tombstone node | Synchronous on WAL apply |
| Crash recovery | Replay WAL from last checkpoint — rebuild graph index | On startup |

---

## Testing

### Property-Based Tests with proptest

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    /// Strategy: generate a random graph, then verify structural invariants.
    fn arb_graph() -> impl Strategy<Value = GraphStorage> {
        (1usize..200, 0usize..500).prop_flat_map(|(num_nodes, num_edges)| {
            let node_labels = prop::collection::vec(
                prop::sample::select(vec!["person", "product", "order"]),
                num_nodes,
            );
            let edges = prop::collection::vec(
                (0..num_nodes as u32, 0..num_nodes as u32),
                num_edges.min(num_nodes * 3), // cap edges relative to nodes
            );
            (Just(num_nodes), node_labels, edges)
        })
        .prop_map(|(num_nodes, node_labels, edges)| {
            let mut graph = GraphStorage::with_capacity(num_nodes, edges.len());
            for (i, label) in node_labels.iter().enumerate() {
                graph.add_node(i as u64, label, 0);
            }
            for (i, (from, to)) in edges.iter().enumerate() {
                graph.add_edge(i as u64, "knows", NodeIndex(*from), NodeIndex(*to), 0);
            }
            graph
        })
    }

    proptest! {
        /// Every edge endpoint must reference a valid node.
        #[test]
        fn edge_endpoints_are_valid(graph in arb_graph()) {
            let n = graph.node_count();
            for i in 0..graph.edge_count() {
                let edge = graph.edge(EdgeIndex(i as u32));
                prop_assert!(edge.from.as_usize() < n, "from out of bounds");
                prop_assert!(edge.to.as_usize() < n, "to out of bounds");
            }
        }

        /// Bidirectional consistency: if edge E is in outgoing[A], then E is in incoming[B].
        #[test]
        fn bidirectional_adjacency_consistent(graph in arb_graph()) {
            for i in 0..graph.node_count() {
                let node = NodeIndex(i as u32);
                for &eidx in graph.outgoing_edges(node) {
                    let edge = graph.edge(eidx);
                    let target = edge.to;
                    prop_assert!(
                        graph.incoming_edges(target).contains(&eidx),
                        "Edge {} in outgoing[{}] but not in incoming[{}]",
                        eidx, node, target
                    );
                }
            }
        }

        /// BFS visits every reachable node exactly once.
        #[test]
        fn bfs_no_duplicates(graph in arb_graph()) {
            if graph.node_count() == 0 { return Ok(()); }
            let results = bfs(&graph, NodeIndex(0), usize::MAX, None);
            let mut seen = std::collections::HashSet::new();
            for (node, _depth) in &results {
                prop_assert!(seen.insert(*node), "BFS visited {} twice", node);
            }
        }

        /// Dijkstra path is valid: consecutive nodes in the path are connected by edges.
        #[test]
        fn dijkstra_path_is_valid(graph in arb_graph()) {
            if graph.node_count() < 2 { return Ok(()); }
            let from = NodeIndex(0);
            let to = NodeIndex((graph.node_count() - 1) as u32);
            if let Some((_cost, path)) = shortest_path(&graph, from, to, |_| 1.0) {
                prop_assert_eq!(path[0], from);
                prop_assert_eq!(*path.last().unwrap(), to);
                for window in path.windows(2) {
                    let has_edge = graph
                        .outgoing_edges(window[0])
                        .iter()
                        .any(|&eidx| graph.edge(eidx).to == window[1]);
                    prop_assert!(has_edge, "No edge from {} to {} in Dijkstra path", window[0], window[1]);
                }
            }
        }

        /// PageRank scores sum to ~1.0 (within floating point tolerance).
        #[test]
        fn pagerank_scores_sum_to_one(graph in arb_graph()) {
            if graph.node_count() == 0 { return Ok(()); }
            let scores = pagerank(&graph, 0.85, 1e-8, 100);
            let sum: f64 = scores.iter().sum();
            prop_assert!((sum - 1.0).abs() < 0.01, "PageRank sum = {}, expected ~1.0", sum);
        }

        /// Connected components: every node is in exactly one component.
        #[test]
        fn components_partition_all_nodes(graph in arb_graph()) {
            let components = connected_components(&graph);
            let total: usize = components.values().map(|v| v.len()).sum();
            prop_assert_eq!(total, graph.node_count());
        }
    }
}
```

### Known-Graph Fixtures

```rust
#[cfg(test)]
mod fixture_tests {
    use super::*;

    /// Build a known triangle graph: A -> B -> C -> A
    fn triangle_graph() -> GraphStorage {
        let mut g = GraphStorage::new();
        let a = g.add_node(1, "person", 0);
        let b = g.add_node(2, "person", 0);
        let c = g.add_node(3, "person", 0);
        g.add_edge(1, "knows", a, b, 0);
        g.add_edge(2, "knows", b, c, 0);
        g.add_edge(3, "knows", c, a, 0);
        g
    }

    #[test]
    fn triangle_bfs_visits_all() {
        let g = triangle_graph();
        let results = bfs(&g, NodeIndex(0), 10, None);
        assert_eq!(results.len(), 3);
    }

    #[test]
    fn triangle_shortest_path() {
        let g = triangle_graph();
        let (cost, path) =
            shortest_path(&g, NodeIndex(0), NodeIndex(2), |_| 1.0).unwrap();
        assert_eq!(cost, 2.0);
        assert_eq!(path, vec![NodeIndex(0), NodeIndex(1), NodeIndex(2)]);
    }

    #[test]
    fn triangle_is_one_component() {
        let g = triangle_graph();
        let components = connected_components(&g);
        assert_eq!(components.len(), 1);
    }

    #[test]
    fn disconnected_components() {
        let mut g = GraphStorage::new();
        let a = g.add_node(1, "person", 0);
        let b = g.add_node(2, "person", 0);
        let c = g.add_node(3, "person", 0);
        let d = g.add_node(4, "person", 0);
        // Component 1: A <-> B
        g.add_edge(1, "knows", a, b, 0);
        g.add_edge(2, "knows", b, a, 0);
        // Component 2: C <-> D
        g.add_edge(3, "knows", c, d, 0);
        g.add_edge(4, "knows", d, c, 0);

        let components = connected_components(&g);
        assert_eq!(components.len(), 2);
    }

    #[test]
    fn pattern_match_two_hop() {
        let mut g = GraphStorage::new();
        let alice = g.add_node(1, "people", 0);
        let bob = g.add_node(2, "people", 0);
        let charlie = g.add_node(3, "people", 0);
        g.add_edge(1, "knows", alice, bob, 0);
        g.add_edge(2, "knows", bob, charlie, 0);

        // Pattern: (a:people)-[:knows]->(b:people)-[:knows]->(c:people)
        let pattern = GraphPattern {
            elements: vec![
                PatternElement::Node {
                    variable: "a".into(),
                    label: Some("people".into()),
                },
                PatternElement::Edge {
                    variable: "k1".into(),
                    label: Some("knows".into()),
                    direction: EdgeDirection::Outgoing,
                    hops: None,
                },
                PatternElement::Node {
                    variable: "b".into(),
                    label: Some("people".into()),
                },
                PatternElement::Edge {
                    variable: "k2".into(),
                    label: Some("knows".into()),
                    direction: EdgeDirection::Outgoing,
                    hops: None,
                },
                PatternElement::Node {
                    variable: "c".into(),
                    label: Some("people".into()),
                },
            ],
        };

        let steps = compile_pattern(&pattern, g.labels());
        let bindings = execute_pattern(&g, &steps);

        // Only one match: alice -> bob -> charlie
        assert_eq!(bindings.len(), 1);
        assert_eq!(bindings[0].nodes["a"], alice);
        assert_eq!(bindings[0].nodes["b"], bob);
        assert_eq!(bindings[0].nodes["c"], charlie);
    }
}
```

### Performance Benchmarks

Target metrics for a production graph engine:

| Operation | Graph size | Target |
|---|---|---|
| BFS (depth 3) | 1M nodes, 10M edges | < 5 ms |
| Dijkstra (shortest path) | 1M nodes, 10M edges | < 50 ms |
| PageRank (10 iterations) | 1M nodes, 10M edges | < 500 ms |
| Connected components | 1M nodes, 10M edges | < 200 ms |
| Pattern match (2-hop) | 1M nodes, 10M edges | < 10 ms (depends on selectivity) |
| Add node | any | < 100 ns |
| Add edge | any | < 200 ns |

Use `criterion` for benchmarking:

```rust
use criterion::{criterion_group, criterion_main, Criterion, BenchmarkId};

fn bench_bfs(c: &mut Criterion) {
    let graph = build_benchmark_graph(1_000_000, 10_000_000);
    c.bench_function("bfs_depth_3_1M", |b| {
        b.iter(|| bfs(&graph, NodeIndex(0), 3, None))
    });
}

fn bench_dijkstra(c: &mut Criterion) {
    let graph = build_benchmark_graph(1_000_000, 10_000_000);
    c.bench_function("dijkstra_1M", |b| {
        b.iter(|| {
            shortest_path(&graph, NodeIndex(0), NodeIndex(999_999), |_| 1.0)
        })
    });
}

fn bench_pagerank(c: &mut Criterion) {
    let graph = build_benchmark_graph(1_000_000, 10_000_000);
    c.bench_function("pagerank_10iter_1M", |b| {
        b.iter(|| pagerank(&graph, 0.85, 1e-6, 10))
    });
}

criterion_group!(benches, bench_bfs, bench_dijkstra, bench_pagerank);
criterion_main!(benches);
```

---

## Never

- **Never use `Rc<RefCell<Node>>` for graph nodes** — use index-based references (`NodeIndex`, `EdgeIndex`). Rc/RefCell is slower, non-Send, and creates garbage collection pressure.
- **Never use recursive DFS on large graphs** — Rust's default stack is 8 MB. A graph with 100K+ depth will stack overflow. Always use iterative traversal with an explicit stack or queue.
- **Never store `&NodeData` references across mutations** — adding a node or edge can reallocate the backing `Vec`, invalidating all references. Use indices.
- **Never use `HashMap<NodeIndex, Vec<EdgeIndex>>` for adjacency** — use `Vec<Vec<EdgeIndex>>` indexed directly by `NodeIndex.0`. HashMap adds 30-50% overhead for this access pattern.
- **Never skip the bidirectional invariant** — when adding an edge from A to B, ALWAYS update both `outgoing[A]` and `incoming[B]`. Forgetting one direction breaks incoming-edge traversals silently.
- **Never use `f64` equality in Dijkstra** — compare with `>` / `<`, not `==`. Floating point accumulation makes exact equality unreliable. The `DijkstraState` Ord impl handles this correctly.
- **Never allocate per-traversal** when you can reuse buffers — for hot-path traversals, accept `&mut Vec<bool>` visited buffers from the caller instead of allocating inside the function.
- **Never use `unsafe` for graph structure** — the entire graph engine is safe Rust. `unsafe` is only justified in the arena allocator internals (bumpalo handles this) or SIMD acceleration of bulk operations.
