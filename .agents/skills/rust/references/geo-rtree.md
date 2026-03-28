# Geo R-Tree — Spatial Indexing and Bi-Temporal Time-Travel Queries

R-tree spatial index for geospatial queries, combined with bi-temporal MVCC versioning for
point-in-time historical access. All examples target the `crates/geo/` and `crates/temporal/`
workspace crates from `references/stack.md`.

## Crate Dependencies

### `crates/geo/Cargo.toml`

```toml
[package]
name = "mydb-geo"
version = "0.1.0"
edition.workspace = true
rust-version.workspace = true

[lints]
workspace = true

[features]
default = []
serde = ["dep:serde", "rstar/serde"]

[dependencies]
mydb-types = { path = "../types" }
mydb-common = { path = "../common" }
rstar = { workspace = true }
memmap2.workspace = true
byteorder.workspace = true
thiserror.workspace = true
tracing.workspace = true
serde = { workspace = true, optional = true }

[dev-dependencies]
proptest.workspace = true
criterion.workspace = true
rand.workspace = true
```

### `crates/temporal/Cargo.toml`

```toml
[package]
name = "mydb-temporal"
version = "0.1.0"
edition.workspace = true
rust-version.workspace = true

[lints]
workspace = true

[features]
default = []
serde = ["dep:serde"]

[dependencies]
mydb-types = { path = "../types" }
mydb-storage = { path = "../storage" }
mydb-common = { path = "../common" }
parking_lot.workspace = true
crossbeam.workspace = true
tracing.workspace = true
thiserror.workspace = true
serde = { workspace = true, optional = true }

[dev-dependencies]
proptest.workspace = true
```

---

## R-Tree Spatial Index with rstar

### Core Imports

```rust
use rstar::{primitives::Rectangle, RTree, RTreeObject, AABB, PointDistance};
```

### Custom Spatial Types

#### GeoPoint

The fundamental spatial primitive. Implements `RTreeObject` so it can be inserted directly
into an R-tree. Also implements `PointDistance` for nearest-neighbor queries.

```rust
use rstar::{RTree, RTreeObject, AABB, PointDistance};

/// A WGS84 coordinate (longitude, latitude) stored as f64.
///
/// rstar indexes on `[f64; 2]` envelopes. We use `[lon, lat]` ordering
/// to match GeoJSON and most geospatial tooling.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GeoPoint {
    pub lon: f64,
    pub lat: f64,
}

impl GeoPoint {
    #[must_use]
    pub fn new(lon: f64, lat: f64) -> Self {
        Self { lon, lat }
    }

    /// Return the [lon, lat] pair as an array for rstar interop.
    #[must_use]
    pub fn as_array(&self) -> [f64; 2] {
        [self.lon, self.lat]
    }
}

impl RTreeObject for GeoPoint {
    type Envelope = AABB<[f64; 2]>;

    fn envelope(&self) -> Self::Envelope {
        AABB::from_point([self.lon, self.lat])
    }
}

impl PointDistance for GeoPoint {
    fn distance_2(&self, point: &[f64; 2]) -> f64 {
        let dx = self.lon - point[0];
        let dy = self.lat - point[1];
        dx * dx + dy * dy
    }
}
```

#### GeoBoundingBox

A rectangle (axis-aligned bounding box) for range queries and polygon approximation.

```rust
/// An axis-aligned bounding box defined by its southwest and northeast corners.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GeoBoundingBox {
    pub min_lon: f64,
    pub min_lat: f64,
    pub max_lon: f64,
    pub max_lat: f64,
}

impl GeoBoundingBox {
    #[must_use]
    pub fn new(min_lon: f64, min_lat: f64, max_lon: f64, max_lat: f64) -> Self {
        Self { min_lon, min_lat, max_lon, max_lat }
    }

    /// Convert to rstar AABB for querying.
    #[must_use]
    pub fn to_aabb(&self) -> AABB<[f64; 2]> {
        AABB::from_corners([self.min_lon, self.min_lat], [self.max_lon, self.max_lat])
    }

    /// Check if a point lies inside this bounding box.
    #[must_use]
    pub fn contains_point(&self, point: &GeoPoint) -> bool {
        point.lon >= self.min_lon
            && point.lon <= self.max_lon
            && point.lat >= self.min_lat
            && point.lat <= self.max_lat
    }
}

impl RTreeObject for GeoBoundingBox {
    type Envelope = AABB<[f64; 2]>;

    fn envelope(&self) -> Self::Envelope {
        self.to_aabb()
    }
}
```

#### GeoIndexEntry

Production R-trees rarely store bare points. Each entry carries an ID (or row reference)
alongside its geometry so the index can be joined back to data.

```rust
/// A spatial index entry associating a row ID with a point.
///
/// This is what goes into the R-tree. Queries return entries, and the caller
/// uses `row_id` to look up the full row from storage.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GeoIndexEntry {
    pub row_id: u64,
    pub point: GeoPoint,
}

impl RTreeObject for GeoIndexEntry {
    type Envelope = AABB<[f64; 2]>;

    fn envelope(&self) -> Self::Envelope {
        self.point.envelope()
    }
}

impl PointDistance for GeoIndexEntry {
    fn distance_2(&self, point: &[f64; 2]) -> f64 {
        self.point.distance_2(point)
    }
}
```

---

### Spatial Queries

#### Building the R-Tree

```rust
use rstar::RTree;

/// Build an R-tree from a vector of entries using bulk loading.
///
/// Bulk loading (via `RTree::bulk_load`) is O(n log n) and produces a
/// better-packed tree than incremental insertion. Always prefer this
/// when you have all data available upfront.
#[must_use]
pub fn build_spatial_index(entries: Vec<GeoIndexEntry>) -> RTree<GeoIndexEntry> {
    RTree::bulk_load(entries)
}
```

#### Point Lookup

```rust
/// Find all entries at an exact coordinate.
///
/// Useful for deduplication checks or exact-match point queries.
pub fn locate_at_point(tree: &RTree<GeoIndexEntry>, lon: f64, lat: f64) -> Vec<&GeoIndexEntry> {
    tree.locate_at_point(&[lon, lat]).collect()
}
```

#### Range Query (Bounding Box Intersection)

```rust
/// Find all entries whose envelope intersects the given bounding box.
///
/// This is the workhorse query: "find everything in this map viewport."
/// rstar prunes entire subtrees whose envelopes do not overlap the query
/// rectangle, making this efficient even for millions of entries.
pub fn range_query<'a>(
    tree: &'a RTree<GeoIndexEntry>,
    bbox: &GeoBoundingBox,
) -> Vec<&'a GeoIndexEntry> {
    tree.locate_in_envelope_intersecting(&bbox.to_aabb()).collect()
}
```

#### K-Nearest Neighbor

```rust
/// Find the k nearest entries to a query point, ordered by distance.
///
/// rstar uses a priority-queue traversal that avoids scanning the entire tree.
/// Distance is Euclidean on the [lon, lat] plane — for true geodesic distance,
/// post-filter with `haversine_distance`.
pub fn knn_query(
    tree: &RTree<GeoIndexEntry>,
    lon: f64,
    lat: f64,
    k: usize,
) -> Vec<&GeoIndexEntry> {
    tree.nearest_neighbor_iter(&[lon, lat]).take(k).collect()
}
```

#### Polygon Containment Query

Two-phase approach: R-tree prunes by bounding box, then exact polygon test filters.

```rust
/// Find all entries inside a polygon.
///
/// Phase 1: Compute the polygon's bounding box, query the R-tree for
///          all entries intersecting that box.
/// Phase 2: Apply point-in-polygon test on the candidate set.
///
/// This avoids running the expensive ray-casting check on every entry.
pub fn within_polygon<'a>(
    tree: &'a RTree<GeoIndexEntry>,
    polygon: &[GeoPoint],
) -> Vec<&'a GeoIndexEntry> {
    let bbox = polygon_bounding_box(polygon);
    tree.locate_in_envelope_intersecting(&bbox.to_aabb())
        .filter(|entry| point_in_polygon(&entry.point, polygon))
        .collect()
}

/// Compute the axis-aligned bounding box of a polygon.
#[must_use]
fn polygon_bounding_box(polygon: &[GeoPoint]) -> GeoBoundingBox {
    let mut min_lon = f64::MAX;
    let mut min_lat = f64::MAX;
    let mut max_lon = f64::MIN;
    let mut max_lat = f64::MIN;

    for p in polygon {
        min_lon = min_lon.min(p.lon);
        min_lat = min_lat.min(p.lat);
        max_lon = max_lon.max(p.lon);
        max_lat = max_lat.max(p.lat);
    }

    GeoBoundingBox::new(min_lon, min_lat, max_lon, max_lat)
}
```

---

### Geo Functions

#### Haversine Distance (WGS84)

```rust
use std::f64::consts::PI;

const EARTH_RADIUS_METERS: f64 = 6_371_000.0;

/// Haversine distance in meters between two WGS84 coordinates.
///
/// Accuracy: ~0.3% for most distances. For sub-meter precision,
/// use Vincenty's formula or the `geo` crate's `Geodesic` trait.
#[must_use]
pub fn haversine_distance(a: &GeoPoint, b: &GeoPoint) -> f64 {
    let d_lat = (b.lat - a.lat).to_radians();
    let d_lon = (b.lon - a.lon).to_radians();
    let lat1 = a.lat.to_radians();
    let lat2 = b.lat.to_radians();

    let h = (d_lat / 2.0).sin().powi(2)
        + lat1.cos() * lat2.cos() * (d_lon / 2.0).sin().powi(2);
    let c = 2.0 * h.sqrt().asin();

    EARTH_RADIUS_METERS * c
}
```

#### Point-in-Polygon (Ray Casting)

```rust
/// Point-in-polygon test using the ray casting algorithm.
///
/// Casts a horizontal ray from the test point to the right. If it crosses
/// an odd number of polygon edges, the point is inside. Works for simple
/// (non-self-intersecting) polygons, including concave ones.
///
/// The polygon is implicitly closed: an edge connects the last vertex
/// back to the first.
#[must_use]
pub fn point_in_polygon(point: &GeoPoint, polygon: &[GeoPoint]) -> bool {
    if polygon.len() < 3 {
        return false;
    }

    let mut inside = false;
    let n = polygon.len();
    let mut j = n - 1;

    for i in 0..n {
        let vi = &polygon[i];
        let vj = &polygon[j];

        // Check if the edge from vj to vi straddles the point's latitude
        let intersects = (vi.lat > point.lat) != (vj.lat > point.lat);
        if intersects {
            // Compute the longitude where the edge crosses point.lat
            let x_intersect =
                vj.lon + (point.lat - vj.lat) / (vi.lat - vj.lat) * (vi.lon - vj.lon);
            if point.lon < x_intersect {
                inside = !inside;
            }
        }
        j = i;
    }

    inside
}
```

#### GEO_DISTANCE — Distance Between Two Points

```rust
/// GEO_DISTANCE(point_a, point_b) -> f64 meters
///
/// Returns the great-circle distance between two points using haversine.
/// Use this for distance filters: `WHERE GEO_DISTANCE(location, center) < 5000.0`
#[must_use]
pub fn geo_distance(a: &GeoPoint, b: &GeoPoint) -> f64 {
    haversine_distance(a, b)
}
```

#### GEO_WITHIN — Point Inside Polygon

```rust
/// GEO_WITHIN(point, polygon) -> bool
///
/// Returns true if the point lies inside the polygon.
/// Use for geofencing: `WHERE GEO_WITHIN(location, delivery_zone)`
#[must_use]
pub fn geo_within(point: &GeoPoint, polygon: &[GeoPoint]) -> bool {
    point_in_polygon(point, polygon)
}
```

#### GEO_INTERSECTS — Bounding Box Overlap

```rust
/// GEO_INTERSECTS(bbox_a, bbox_b) -> bool
///
/// Returns true if two bounding boxes overlap. Used for coarse spatial
/// joins and map-tile visibility tests.
#[must_use]
pub fn geo_intersects(a: &GeoBoundingBox, b: &GeoBoundingBox) -> bool {
    a.min_lon <= b.max_lon
        && a.max_lon >= b.min_lon
        && a.min_lat <= b.max_lat
        && a.max_lat >= b.min_lat
}
```

#### GEO_NEAREST — K Closest Points with Geodesic Distance

```rust
/// GEO_NEAREST(tree, center, k, max_distance_meters) -> Vec<(row_id, distance)>
///
/// Returns up to k nearest entries within max_distance_meters.
/// Uses the R-tree for candidate generation, then filters by haversine distance.
pub fn geo_nearest(
    tree: &RTree<GeoIndexEntry>,
    center: &GeoPoint,
    k: usize,
    max_distance_meters: f64,
) -> Vec<(u64, f64)> {
    tree.nearest_neighbor_iter(&center.as_array())
        .map(|entry| {
            let dist = haversine_distance(center, &entry.point);
            (entry.row_id, dist)
        })
        .take_while(|&(_, dist)| dist <= max_distance_meters)
        .take(k)
        .collect()
}
```

---

### Index Lifecycle

#### Bulk Loading vs Incremental Insert

```rust
/// Build a packed R-tree from a data iterator.
///
/// Bulk loading produces a tree with ~70% fill factor (vs ~50% for incremental).
/// Always prefer this when loading from a segment file or snapshot.
pub fn load_from_segment(
    rows: impl Iterator<Item = (u64, f64, f64)>,
) -> RTree<GeoIndexEntry> {
    let entries: Vec<GeoIndexEntry> = rows
        .map(|(row_id, lon, lat)| GeoIndexEntry {
            row_id,
            point: GeoPoint::new(lon, lat),
        })
        .collect();
    RTree::bulk_load(entries)
}

/// Insert a single entry into an existing R-tree.
///
/// Used for real-time ingestion. After many incremental inserts the tree
/// degrades — rebuild from bulk load during compaction.
pub fn insert_entry(tree: &mut RTree<GeoIndexEntry>, row_id: u64, lon: f64, lat: f64) {
    tree.insert(GeoIndexEntry {
        row_id,
        point: GeoPoint::new(lon, lat),
    });
}

/// Remove an entry from the R-tree by exact match.
///
/// Returns the removed entry if found. Called during row deletion or update
/// (delete old + insert new).
pub fn remove_entry(
    tree: &mut RTree<GeoIndexEntry>,
    row_id: u64,
    lon: f64,
    lat: f64,
) -> Option<GeoIndexEntry> {
    tree.remove(&GeoIndexEntry {
        row_id,
        point: GeoPoint::new(lon, lat),
    })
}
```

#### Serialization to Segment Files

```rust
use byteorder::{LittleEndian, ReadBytesExt, WriteBytesExt};
use std::io::{self, Read, Write};

const GEO_INDEX_MAGIC: [u8; 4] = *b"GEOI";
const GEO_INDEX_VERSION: u8 = 1;

/// Serialize an R-tree's entries to a binary segment file.
///
/// Format:
///   [4 bytes magic] [1 byte version] [3 bytes reserved]
///   [8 bytes entry_count]
///   [entry_count * 24 bytes: (row_id: u64, lon: f64, lat: f64)]
///
/// The R-tree itself is not serialized — it is rebuilt via bulk_load
/// on read, which produces an optimal packing.
pub fn write_geo_index<W: Write>(
    writer: &mut W,
    tree: &RTree<GeoIndexEntry>,
) -> io::Result<()> {
    writer.write_all(&GEO_INDEX_MAGIC)?;
    writer.write_u8(GEO_INDEX_VERSION)?;
    writer.write_all(&[0u8; 3])?; // reserved

    let entries: Vec<&GeoIndexEntry> = tree.iter().collect();
    writer.write_u64::<LittleEndian>(entries.len() as u64)?;

    for entry in &entries {
        writer.write_u64::<LittleEndian>(entry.row_id)?;
        writer.write_f64::<LittleEndian>(entry.point.lon)?;
        writer.write_f64::<LittleEndian>(entry.point.lat)?;
    }

    Ok(())
}

/// Deserialize entries from a geo index segment and rebuild the R-tree.
pub fn read_geo_index<R: Read>(reader: &mut R) -> io::Result<RTree<GeoIndexEntry>> {
    let mut magic = [0u8; 4];
    reader.read_exact(&mut magic)?;
    if magic != GEO_INDEX_MAGIC {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid geo index magic bytes",
        ));
    }

    let version = reader.read_u8()?;
    if version != GEO_INDEX_VERSION {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("unsupported geo index version: {version}"),
        ));
    }

    let mut reserved = [0u8; 3];
    reader.read_exact(&mut reserved)?;

    let count = reader.read_u64::<LittleEndian>()? as usize;
    let mut entries = Vec::with_capacity(count);

    for _ in 0..count {
        let row_id = reader.read_u64::<LittleEndian>()?;
        let lon = reader.read_f64::<LittleEndian>()?;
        let lat = reader.read_f64::<LittleEndian>()?;
        entries.push(GeoIndexEntry {
            row_id,
            point: GeoPoint::new(lon, lat),
        });
    }

    Ok(RTree::bulk_load(entries))
}
```

#### Memory-Mapped R-Tree for Read-Heavy Workloads

```rust
use memmap2::Mmap;
use std::fs::File;
use std::path::Path;

/// A read-only spatial index backed by a memory-mapped file.
///
/// The mmap holds the serialized entry array. On construction, entries
/// are parsed and bulk-loaded into an R-tree. The mmap stays alive to
/// avoid a second copy of the coordinate data if entries are extended
/// to reference the mapped region.
pub struct MmapGeoIndex {
    _mmap: Mmap,
    tree: RTree<GeoIndexEntry>,
}

impl MmapGeoIndex {
    /// Open a geo index segment file as a memory-mapped R-tree.
    ///
    /// # Safety
    ///
    /// The caller must ensure the file is not modified while the mmap is live.
    /// In practice, segment files are immutable once written.
    pub fn open(path: &Path) -> io::Result<Self> {
        let file = File::open(path)?;
        // SAFETY: Segment files are immutable after creation. No concurrent
        // writer will modify this file. The Mmap lifetime is tied to this struct.
        let mmap = unsafe { Mmap::map(&file)? };
        mmap.advise(memmap2::Advice::Random)?;

        let mut cursor = &mmap[..];
        let tree = read_geo_index(&mut cursor)?;

        Ok(Self { _mmap: mmap, tree })
    }

    pub fn tree(&self) -> &RTree<GeoIndexEntry> {
        &self.tree
    }
}
```

---

## Bi-Temporal Time-Travel

### Concepts

Bi-temporal versioning tracks two independent time axes:

| Axis | What it records | Example |
|------|----------------|---------|
| **Valid time** (event time) | When the fact was true in the real world | "This sensor reading was taken at 14:30" |
| **System time** (transaction time) | When the system recorded the fact | "We ingested this row at 14:35 in txn #4207" |

Both axes are queryable independently:

- `AS OF SYSTEM TIME <txn_id>` — see the state of the data as the system knew it at that transaction.
- `FOR VALID TIME AS OF <timestamp>` — see what was true in the real world at that moment.
- Combined: "What did the system believe was true about 14:30, as of txn #4207?"

Powered by MVCC: old row versions are retained until a retention policy garbage-collects them.
Each version carries both valid-time and system-time ranges.

### Error Types

```rust
use thiserror::Error;

#[derive(Debug, Error)]
pub enum TemporalError {
    #[error("version not found at system time {system_time}")]
    VersionNotFound { system_time: u64 },

    #[error("valid time range is empty: valid_from ({valid_from}) >= valid_to ({valid_to})")]
    EmptyValidTimeRange { valid_from: i64, valid_to: i64 },

    #[error("snapshot {snapshot_id} is still active; cannot GC versions it depends on")]
    ActiveSnapshot { snapshot_id: u64 },

    #[error(transparent)]
    Storage(#[from] std::io::Error),
}
```

### Data Model

```rust
/// Temporal metadata attached to every row version.
///
/// Encodes both valid-time (when the fact was true) and system-time
/// (which transaction created/superseded this version).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TemporalMetadata {
    /// Event time start — microseconds since Unix epoch.
    /// When this fact became true in the real world.
    pub valid_from: i64,

    /// Event time end — microseconds since Unix epoch.
    /// `None` means the fact is still current (open-ended).
    pub valid_to: Option<i64>,

    /// Transaction ID that created this version.
    pub system_from: u64,

    /// Transaction ID that superseded this version.
    /// `None` means this is the current system version.
    pub system_to: Option<u64>,
}

impl TemporalMetadata {
    /// Check if this version is visible at the given system time.
    #[must_use]
    pub fn visible_at_system_time(&self, system_time: u64) -> bool {
        self.system_from <= system_time
            && self.system_to.map_or(true, |end| end > system_time)
    }

    /// Check if this version's valid time overlaps the given instant.
    #[must_use]
    pub fn valid_at(&self, timestamp: i64) -> bool {
        self.valid_from <= timestamp
            && self.valid_to.map_or(true, |end| end > timestamp)
    }

    /// Check if this version is visible under both time axes.
    #[must_use]
    pub fn visible_at(&self, system_time: u64, valid_time: i64) -> bool {
        self.visible_at_system_time(system_time) && self.valid_at(valid_time)
    }
}
```

### MVCC Version Chain

```rust
/// A single row version in the MVCC chain.
///
/// Each row is identified by a primary key. Multiple versions of the same
/// row exist, distinguished by their `TemporalMetadata`. The version chain
/// is ordered by `system_from` ascending.
#[derive(Debug, Clone)]
pub struct MvccVersion {
    pub row_id: u64,
    pub temporal: TemporalMetadata,
    pub data: Vec<u8>, // Serialized row payload
}

/// Resolve the visible version of a row at a given system time.
///
/// Scans the version chain (ordered by system_from ascending) and returns
/// the latest version that was created at or before `system_time` and not
/// yet superseded.
///
/// This is the core of `AS OF SYSTEM TIME` queries.
#[must_use]
pub fn snapshot_at_system_time(
    versions: &[MvccVersion],
    system_time: u64,
) -> Option<&MvccVersion> {
    versions
        .iter()
        .filter(|v| v.temporal.visible_at_system_time(system_time))
        .last()
}

/// Resolve the visible version at a specific valid time within a system snapshot.
///
/// This is the core of combined bi-temporal queries:
/// `AS OF SYSTEM TIME <sys> FOR VALID TIME AS OF <valid>`
#[must_use]
pub fn snapshot_bitemporal(
    versions: &[MvccVersion],
    system_time: u64,
    valid_time: i64,
) -> Option<&MvccVersion> {
    versions
        .iter()
        .filter(|v| v.temporal.visible_at(system_time, valid_time))
        .last()
}
```

### Version Lifecycle: Insert, Update, Delete

```rust
use std::sync::atomic::{AtomicU64, Ordering};

/// Global transaction counter. Each write operation gets a unique, monotonically
/// increasing transaction ID.
static NEXT_TXN_ID: AtomicU64 = AtomicU64::new(1);

fn next_txn_id() -> u64 {
    NEXT_TXN_ID.fetch_add(1, Ordering::Relaxed)
}

/// Insert a new row version with the given valid-time range.
pub fn temporal_insert(
    versions: &mut Vec<MvccVersion>,
    row_id: u64,
    data: Vec<u8>,
    valid_from: i64,
    valid_to: Option<i64>,
) -> u64 {
    let txn_id = next_txn_id();
    versions.push(MvccVersion {
        row_id,
        temporal: TemporalMetadata {
            valid_from,
            valid_to,
            system_from: txn_id,
            system_to: None,
        },
        data,
    });
    txn_id
}

/// Update a row: close the current version's system_to and insert a new version.
///
/// The old version remains visible for queries at earlier system times.
pub fn temporal_update(
    versions: &mut Vec<MvccVersion>,
    row_id: u64,
    new_data: Vec<u8>,
    new_valid_from: i64,
    new_valid_to: Option<i64>,
) -> Result<u64, TemporalError> {
    let txn_id = next_txn_id();

    // Close the current version
    let current = versions
        .iter_mut()
        .rev()
        .find(|v| v.row_id == row_id && v.temporal.system_to.is_none());
    match current {
        Some(v) => v.temporal.system_to = Some(txn_id),
        None => {
            return Err(TemporalError::VersionNotFound { system_time: txn_id });
        }
    }

    // Insert the new version
    versions.push(MvccVersion {
        row_id,
        temporal: TemporalMetadata {
            valid_from: new_valid_from,
            valid_to: new_valid_to,
            system_from: txn_id,
            system_to: None,
        },
        data: new_data,
    });

    Ok(txn_id)
}

/// Delete a row: close the current version's system_to without inserting a replacement.
///
/// The row vanishes from future queries but remains visible at earlier system times.
pub fn temporal_delete(
    versions: &mut Vec<MvccVersion>,
    row_id: u64,
) -> Result<u64, TemporalError> {
    let txn_id = next_txn_id();

    let current = versions
        .iter_mut()
        .rev()
        .find(|v| v.row_id == row_id && v.temporal.system_to.is_none());
    match current {
        Some(v) => v.temporal.system_to = Some(txn_id),
        None => {
            return Err(TemporalError::VersionNotFound { system_time: txn_id });
        }
    }

    Ok(txn_id)
}
```

### Temporal Joins

Temporal joins resolve a related table's state at the event time of each driving row.
For example: "For each order, look up the inventory as it was when the order was placed."

```rust
/// A row from the driving table (e.g., orders) with a timestamp to join on.
#[derive(Debug)]
pub struct TemporalJoinProbe {
    pub row_id: u64,
    pub join_key: u64,       // Foreign key into the build table
    pub event_time: i64,     // Look up the build table AS OF this time
}

/// A versioned row from the build table (e.g., inventory).
#[derive(Debug)]
pub struct TemporalJoinBuild {
    pub key: u64,
    pub versions: Vec<MvccVersion>,
}

/// Result of a temporal join: the probe row paired with the matching build version.
#[derive(Debug)]
pub struct TemporalJoinResult<'a> {
    pub probe_row_id: u64,
    pub build_version: Option<&'a MvccVersion>,
}

/// Execute a temporal join.
///
/// For each probe row, find the build-side version that was valid at
/// `probe.event_time`. Uses the same MVCC machinery, parameterized
/// by the probe row's timestamp instead of a global query time.
///
/// Equivalent to:
///   SELECT * FROM orders o
///   JOIN inventory AS OF o.placed_at i ON o.product_id = i.product_id
pub fn temporal_join<'a>(
    probes: &[TemporalJoinProbe],
    build_table: &'a [TemporalJoinBuild],
) -> Vec<TemporalJoinResult<'a>> {
    // Build a lookup map: key -> &TemporalJoinBuild
    let build_map: std::collections::HashMap<u64, &TemporalJoinBuild> =
        build_table.iter().map(|b| (b.key, b)).collect();

    probes
        .iter()
        .map(|probe| {
            let build_version = build_map.get(&probe.join_key).and_then(|build| {
                // Find the version valid at the probe's event time
                build
                    .versions
                    .iter()
                    .filter(|v| v.temporal.valid_at(probe.event_time))
                    .filter(|v| v.temporal.system_to.is_none()) // current system version
                    .last()
            });
            TemporalJoinResult {
                probe_row_id: probe.row_id,
                build_version,
            }
        })
        .collect()
}
```

### Time-Range Segment Pruning

Segments store min/max timestamps in their metadata. Range queries skip
segments that cannot contain matching rows.

```rust
/// Time range metadata stored in each segment's header.
///
/// Both valid-time and system-time ranges are tracked so both
/// temporal axes can prune segments.
#[derive(Debug, Clone, Copy)]
pub struct SegmentTimeRange {
    /// Minimum valid_from across all rows in the segment.
    pub min_valid_time: i64,
    /// Maximum valid_to (or valid_from for open-ended rows) across all rows.
    pub max_valid_time: i64,
    /// Minimum system_from (transaction ID) in the segment.
    pub min_system_time: u64,
    /// Maximum system_from in the segment.
    pub max_system_time: u64,
}

/// Check if a segment might contain rows visible at the given system time.
#[must_use]
pub fn segment_visible_at_system_time(
    segment: &SegmentTimeRange,
    system_time: u64,
) -> bool {
    // Segment must have been created at or before the query time
    segment.min_system_time <= system_time
}

/// Check if a segment might contain rows with valid time in [query_start, query_end).
#[must_use]
pub fn segment_overlaps_valid_range(
    segment: &SegmentTimeRange,
    query_start: i64,
    query_end: i64,
) -> bool {
    segment.max_valid_time >= query_start && segment.min_valid_time < query_end
}

/// Filter a list of segments, keeping only those that might contain
/// rows matching the bi-temporal predicate.
pub fn prune_segments(
    segments: &[SegmentTimeRange],
    system_time: u64,
    valid_start: i64,
    valid_end: i64,
) -> Vec<usize> {
    segments
        .iter()
        .enumerate()
        .filter(|(_, seg)| {
            segment_visible_at_system_time(seg, system_time)
                && segment_overlaps_valid_range(seg, valid_start, valid_end)
        })
        .map(|(idx, _)| idx)
        .collect()
}
```

### Retention Policies and Garbage Collection

```rust
use std::time::Duration;
use parking_lot::Mutex;
use std::sync::Arc;

/// Tiered retention policy controlling how long old versions survive.
///
/// Versions progress through tiers: hot -> warm -> cold -> deleted.
/// The GC task runs periodically and promotes or removes versions
/// based on their age relative to these thresholds.
#[derive(Debug, Clone)]
pub struct RetentionPolicy {
    /// Versions younger than this are kept in memory (hot tier).
    pub hot_duration: Duration,
    /// Versions older than hot but younger than warm are compacted
    /// and served from mmap'd segment files.
    pub warm_duration: Duration,
    /// Versions older than warm but younger than cold are archived
    /// to object storage (S3, GCS, etc.).
    pub cold_duration: Duration,
    /// How often the GC task runs.
    pub gc_interval: Duration,
}

impl Default for RetentionPolicy {
    fn default() -> Self {
        Self {
            hot_duration: Duration::from_secs(3600),       // 1 hour
            warm_duration: Duration::from_secs(86_400),    // 1 day
            cold_duration: Duration::from_secs(2_592_000), // 30 days
            gc_interval: Duration::from_secs(300),         // 5 minutes
        }
    }
}

/// Active snapshot registry. GC must not remove versions that an active
/// snapshot still references.
#[derive(Debug, Default)]
pub struct SnapshotRegistry {
    /// Set of transaction IDs with active snapshots.
    active: std::collections::BTreeSet<u64>,
}

impl SnapshotRegistry {
    /// Register a new snapshot. Returns the current txn_id as the snapshot point.
    pub fn acquire(&mut self, txn_id: u64) {
        self.active.insert(txn_id);
    }

    /// Release a snapshot, allowing GC to reclaim versions it protected.
    pub fn release(&mut self, txn_id: u64) {
        self.active.remove(&txn_id);
    }

    /// Return the oldest active snapshot. GC cannot remove versions visible
    /// at or after this transaction ID.
    #[must_use]
    pub fn oldest_active(&self) -> Option<u64> {
        self.active.iter().next().copied()
    }
}

/// Garbage-collect expired versions from the version chain.
///
/// A version is eligible for GC when:
/// 1. It has been superseded (`system_to` is `Some`).
/// 2. It was superseded before the oldest active snapshot.
/// 3. It is older than the retention policy's cold duration.
///
/// Returns the number of versions removed.
pub fn gc_versions(
    versions: &mut Vec<MvccVersion>,
    policy: &RetentionPolicy,
    snapshots: &SnapshotRegistry,
    current_txn_id: u64,
) -> usize {
    let oldest_snapshot = snapshots.oldest_active().unwrap_or(current_txn_id);

    // Convert cold_duration to a txn_id threshold (approximation —
    // in production, map wall-clock time to txn_id via a time oracle).
    let cold_threshold = current_txn_id.saturating_sub(
        policy.cold_duration.as_secs() // Simplified: 1 txn/sec approximation
    );

    let before = versions.len();
    versions.retain(|v| {
        match v.temporal.system_to {
            // Current versions are never GC'd.
            None => true,
            // Superseded versions: keep if still needed.
            Some(superseded_at) => {
                // Protected by an active snapshot.
                if superseded_at >= oldest_snapshot {
                    return true;
                }
                // Within retention window.
                if v.temporal.system_from > cold_threshold {
                    return true;
                }
                // Safe to remove.
                false
            }
        }
    });
    before - versions.len()
}

/// Background GC task. Runs on a dedicated tokio task, wakes up every
/// `gc_interval`, and sweeps expired versions.
pub async fn run_gc_loop(
    versions: Arc<Mutex<Vec<MvccVersion>>>,
    snapshots: Arc<Mutex<SnapshotRegistry>>,
    policy: RetentionPolicy,
) {
    let mut interval = tokio::time::interval(policy.gc_interval);

    loop {
        interval.tick().await;

        let current_txn = NEXT_TXN_ID.load(Ordering::Relaxed);
        let snap_guard = snapshots.lock();
        let removed = {
            let mut ver_guard = versions.lock();
            gc_versions(&mut ver_guard, &policy, &snap_guard, current_txn)
        };
        drop(snap_guard);

        if removed > 0 {
            tracing::info!(removed, "GC swept expired versions");
        }
    }
}
```

---

## Composing Geo + Temporal

The combined query pattern: "Find all locations within a polygon, as of 2 hours ago."

```rust
use std::time::{SystemTime, UNIX_EPOCH};

/// A geo-temporal record: a spatial location with versioned data.
#[derive(Debug, Clone)]
pub struct GeoTemporalRecord {
    pub row_id: u64,
    pub point: GeoPoint,
    pub versions: Vec<MvccVersion>,
}

/// Result of a geo-temporal query.
#[derive(Debug)]
pub struct GeoTemporalResult<'a> {
    pub row_id: u64,
    pub point: GeoPoint,
    pub version: &'a MvccVersion,
}

/// Execute a geo-temporal query: spatial filter + temporal snapshot.
///
/// Steps:
/// 1. Compute the temporal snapshot point (system_time).
/// 2. Use the R-tree to find candidate entries within the polygon.
/// 3. For each candidate, resolve the MVCC version visible at the snapshot time.
/// 4. Optionally filter by valid time.
///
/// This is predicate pushdown: spatial pruning happens first (cheap, via R-tree),
/// then temporal resolution runs only on the surviving candidates.
pub fn query_geo_temporal<'a>(
    tree: &RTree<GeoIndexEntry>,
    records: &'a [GeoTemporalRecord],
    polygon: &[GeoPoint],
    system_time: u64,
    valid_time: Option<i64>,
) -> Vec<GeoTemporalResult<'a>> {
    // Phase 1: Spatial filter — R-tree prunes by polygon bounding box,
    // then exact point-in-polygon test.
    let spatial_hits = within_polygon(tree, polygon);

    // Build a lookup from row_id -> GeoTemporalRecord
    let record_map: std::collections::HashMap<u64, &GeoTemporalRecord> =
        records.iter().map(|r| (r.row_id, r)).collect();

    // Phase 2: Temporal resolution — for each spatial hit, find the visible version.
    spatial_hits
        .into_iter()
        .filter_map(|entry| {
            let record = record_map.get(&entry.row_id)?;
            let version = match valid_time {
                Some(vt) => snapshot_bitemporal(&record.versions, system_time, vt),
                None => snapshot_at_system_time(&record.versions, system_time),
            };
            version.map(|v| GeoTemporalResult {
                row_id: entry.row_id,
                point: record.point,
                version: v,
            })
        })
        .collect()
}

/// Convenience: query "within polygon, as of N seconds ago."
pub fn query_within_polygon_as_of<'a>(
    tree: &RTree<GeoIndexEntry>,
    records: &'a [GeoTemporalRecord],
    polygon: &[GeoPoint],
    seconds_ago: u64,
    current_txn_id: u64,
) -> Vec<GeoTemporalResult<'a>> {
    // Approximate system_time from wall clock offset.
    // In production, use a time oracle that maps wall time to txn_id.
    let system_time = current_txn_id.saturating_sub(seconds_ago);

    let now_micros = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_micros() as i64;
    let valid_time = now_micros - (seconds_ago as i64 * 1_000_000);

    query_geo_temporal(tree, records, polygon, system_time, Some(valid_time))
}
```

---

## Testing

### Property Tests: R-Tree Invariants

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    /// Generate a random GeoPoint within valid WGS84 bounds.
    fn arb_geo_point() -> impl Strategy<Value = GeoPoint> {
        (-180.0f64..180.0, -90.0f64..90.0)
            .prop_map(|(lon, lat)| GeoPoint::new(lon, lat))
    }

    /// Generate a random GeoIndexEntry.
    fn arb_geo_entry() -> impl Strategy<Value = GeoIndexEntry> {
        (any::<u64>(), arb_geo_point()).prop_map(|(row_id, point)| GeoIndexEntry {
            row_id,
            point,
        })
    }

    proptest! {
        /// Nearest-neighbor results are ordered by increasing distance.
        #[test]
        fn knn_ordering_is_monotonic(
            entries in prop::collection::vec(arb_geo_entry(), 10..200),
            query_lon in -180.0f64..180.0,
            query_lat in -90.0f64..90.0,
        ) {
            let tree = RTree::bulk_load(entries);
            let results = knn_query(&tree, query_lon, query_lat, 20);

            for window in results.windows(2) {
                let d0 = window[0].point.distance_2(&[query_lon, query_lat]);
                let d1 = window[1].point.distance_2(&[query_lon, query_lat]);
                prop_assert!(d0 <= d1, "KNN results not in distance order: {d0} > {d1}");
            }
        }

        /// Every point returned by range_query is inside the bounding box.
        #[test]
        fn range_query_results_inside_bbox(
            entries in prop::collection::vec(arb_geo_entry(), 10..200),
            min_lon in -180.0f64..0.0,
            min_lat in -90.0f64..0.0,
        ) {
            let max_lon = min_lon + 10.0_f64.min(180.0 - min_lon);
            let max_lat = min_lat + 10.0_f64.min(90.0 - min_lat);
            let bbox = GeoBoundingBox::new(min_lon, min_lat, max_lon, max_lat);

            let tree = RTree::bulk_load(entries);
            let results = range_query(&tree, &bbox);

            for entry in results {
                let p = &entry.point;
                prop_assert!(
                    p.lon >= min_lon && p.lon <= max_lon
                        && p.lat >= min_lat && p.lat <= max_lat,
                    "Point ({}, {}) outside bbox [{}, {}] - [{}, {}]",
                    p.lon, p.lat, min_lon, min_lat, max_lon, max_lat,
                );
            }
        }

        /// Serialization round-trip: write entries, read them back, verify equality.
        #[test]
        fn geo_index_serialization_roundtrip(
            entries in prop::collection::vec(arb_geo_entry(), 0..500),
        ) {
            let tree = RTree::bulk_load(entries.clone());

            let mut buf = Vec::new();
            write_geo_index(&mut buf, &tree).unwrap();

            let mut cursor = buf.as_slice();
            let restored = read_geo_index(&mut cursor).unwrap();

            let mut original: Vec<_> = tree.iter().collect();
            let mut restored_entries: Vec<_> = restored.iter().collect();

            // Sort both by row_id for deterministic comparison
            original.sort_by_key(|e| e.row_id);
            restored_entries.sort_by_key(|e| e.row_id);

            prop_assert_eq!(original.len(), restored_entries.len());
            for (a, b) in original.iter().zip(restored_entries.iter()) {
                prop_assert_eq!(a.row_id, b.row_id);
                prop_assert!((a.point.lon - b.point.lon).abs() < f64::EPSILON);
                prop_assert!((a.point.lat - b.point.lat).abs() < f64::EPSILON);
            }
        }
    }
}
```

### Known-Polygon Fixtures for Containment Tests

```rust
#[cfg(test)]
mod polygon_tests {
    use super::*;

    /// A unit square from (0,0) to (1,1).
    fn unit_square() -> Vec<GeoPoint> {
        vec![
            GeoPoint::new(0.0, 0.0),
            GeoPoint::new(1.0, 0.0),
            GeoPoint::new(1.0, 1.0),
            GeoPoint::new(0.0, 1.0),
        ]
    }

    /// A concave L-shaped polygon.
    fn l_shape() -> Vec<GeoPoint> {
        vec![
            GeoPoint::new(0.0, 0.0),
            GeoPoint::new(2.0, 0.0),
            GeoPoint::new(2.0, 1.0),
            GeoPoint::new(1.0, 1.0),
            GeoPoint::new(1.0, 2.0),
            GeoPoint::new(0.0, 2.0),
        ]
    }

    #[test]
    fn point_inside_unit_square() {
        let sq = unit_square();
        assert!(point_in_polygon(&GeoPoint::new(0.5, 0.5), &sq));
        assert!(point_in_polygon(&GeoPoint::new(0.1, 0.9), &sq));
    }

    #[test]
    fn point_outside_unit_square() {
        let sq = unit_square();
        assert!(!point_in_polygon(&GeoPoint::new(-0.1, 0.5), &sq));
        assert!(!point_in_polygon(&GeoPoint::new(1.1, 0.5), &sq));
        assert!(!point_in_polygon(&GeoPoint::new(0.5, -0.1), &sq));
        assert!(!point_in_polygon(&GeoPoint::new(0.5, 1.1), &sq));
    }

    #[test]
    fn concave_polygon_inside_outside() {
        let l = l_shape();
        // Inside the bottom-left rectangle
        assert!(point_in_polygon(&GeoPoint::new(0.5, 0.5), &l));
        // Inside the top-left column
        assert!(point_in_polygon(&GeoPoint::new(0.5, 1.5), &l));
        // Outside — in the concave notch (top-right)
        assert!(!point_in_polygon(&GeoPoint::new(1.5, 1.5), &l));
        // Outside — completely outside
        assert!(!point_in_polygon(&GeoPoint::new(3.0, 0.5), &l));
    }

    #[test]
    fn degenerate_polygon_rejected() {
        // Fewer than 3 vertices — not a polygon
        assert!(!point_in_polygon(
            &GeoPoint::new(0.0, 0.0),
            &[GeoPoint::new(0.0, 0.0), GeoPoint::new(1.0, 1.0)],
        ));
    }

    #[test]
    fn haversine_known_distances() {
        // New York to London: ~5,570 km
        let nyc = GeoPoint::new(-74.006, 40.7128);
        let london = GeoPoint::new(-0.1278, 51.5074);
        let dist = haversine_distance(&nyc, &london);
        assert!((dist - 5_570_000.0).abs() < 50_000.0, "NYC-London: {dist}m");

        // Same point: zero distance
        let origin = GeoPoint::new(0.0, 0.0);
        assert!((haversine_distance(&origin, &origin)).abs() < f64::EPSILON);
    }

    #[test]
    fn geo_intersects_overlapping_boxes() {
        let a = GeoBoundingBox::new(0.0, 0.0, 2.0, 2.0);
        let b = GeoBoundingBox::new(1.0, 1.0, 3.0, 3.0);
        assert!(geo_intersects(&a, &b));
    }

    #[test]
    fn geo_intersects_disjoint_boxes() {
        let a = GeoBoundingBox::new(0.0, 0.0, 1.0, 1.0);
        let b = GeoBoundingBox::new(2.0, 2.0, 3.0, 3.0);
        assert!(!geo_intersects(&a, &b));
    }
}
```

### Temporal Tests: Insert, Update, Delete, Query at Each Point in Time

```rust
#[cfg(test)]
mod temporal_tests {
    use super::*;

    fn make_version(
        row_id: u64,
        data: &[u8],
        valid_from: i64,
        valid_to: Option<i64>,
        system_from: u64,
        system_to: Option<u64>,
    ) -> MvccVersion {
        MvccVersion {
            row_id,
            temporal: TemporalMetadata {
                valid_from,
                valid_to,
                system_from,
                system_to,
            },
            data: data.to_vec(),
        }
    }

    #[test]
    fn insert_then_snapshot() {
        let mut versions = Vec::new();
        let txn1 = temporal_insert(&mut versions, 1, b"v1".to_vec(), 1000, None);

        // Visible at txn1
        let snap = snapshot_at_system_time(&versions, txn1);
        assert!(snap.is_some());
        assert_eq!(snap.unwrap().data, b"v1");

        // Not visible before txn1
        let snap_before = snapshot_at_system_time(&versions, txn1 - 1);
        assert!(snap_before.is_none());
    }

    #[test]
    fn update_preserves_history() {
        let mut versions = Vec::new();
        let txn1 = temporal_insert(&mut versions, 1, b"v1".to_vec(), 1000, None);
        let txn2 = temporal_update(
            &mut versions,
            1,
            b"v2".to_vec(),
            2000,
            None,
        )
        .unwrap();

        // At txn1: see v1
        let snap1 = snapshot_at_system_time(&versions, txn1);
        assert_eq!(snap1.unwrap().data, b"v1");

        // At txn2: see v2
        let snap2 = snapshot_at_system_time(&versions, txn2);
        assert_eq!(snap2.unwrap().data, b"v2");
    }

    #[test]
    fn delete_hides_from_future() {
        let mut versions = Vec::new();
        let txn1 = temporal_insert(&mut versions, 1, b"v1".to_vec(), 1000, None);
        let txn2 = temporal_delete(&mut versions, 1).unwrap();

        // Still visible at txn1
        let snap1 = snapshot_at_system_time(&versions, txn1);
        assert!(snap1.is_some());

        // Gone at txn2
        let snap2 = snapshot_at_system_time(&versions, txn2);
        assert!(snap2.is_none());
    }

    #[test]
    fn bitemporal_query() {
        let versions = vec![
            // Version 1: valid [1000, 2000), created at txn 10, superseded at txn 20
            make_version(1, b"price_100", 1000, Some(2000), 10, Some(20)),
            // Version 2: valid [2000, _), created at txn 20, still current
            make_version(1, b"price_200", 2000, None, 20, None),
        ];

        // At system time 15, valid time 1500: see price_100
        let v = snapshot_bitemporal(&versions, 15, 1500);
        assert_eq!(v.unwrap().data, b"price_100");

        // At system time 25, valid time 1500: price_100 was superseded at txn 20
        let v = snapshot_bitemporal(&versions, 25, 1500);
        assert!(v.is_none());

        // At system time 25, valid time 2500: see price_200
        let v = snapshot_bitemporal(&versions, 25, 2500);
        assert_eq!(v.unwrap().data, b"price_200");
    }

    #[test]
    fn segment_pruning() {
        let segments = vec![
            SegmentTimeRange {
                min_valid_time: 1000,
                max_valid_time: 2000,
                min_system_time: 1,
                max_system_time: 10,
            },
            SegmentTimeRange {
                min_valid_time: 3000,
                max_valid_time: 4000,
                min_system_time: 5,
                max_system_time: 15,
            },
            SegmentTimeRange {
                min_valid_time: 5000,
                max_valid_time: 6000,
                min_system_time: 20,
                max_system_time: 30,
            },
        ];

        // Query at system time 12, valid range [1500, 3500)
        let surviving = prune_segments(&segments, 12, 1500, 3500);
        // Segment 0: system min 1 <= 12, valid [1000,2000] overlaps [1500,3500) -> yes
        // Segment 1: system min 5 <= 12, valid [3000,4000] overlaps [1500,3500) -> yes
        // Segment 2: system min 20 > 12 -> pruned
        assert_eq!(surviving, vec![0, 1]);
    }

    #[test]
    fn gc_respects_active_snapshots() {
        let mut versions = vec![
            make_version(1, b"old", 1000, None, 1, Some(10)),
            make_version(1, b"current", 1000, None, 10, None),
        ];

        let policy = RetentionPolicy {
            cold_duration: Duration::from_secs(5),
            ..RetentionPolicy::default()
        };

        // Active snapshot at txn 5 protects the old version
        let mut snapshots = SnapshotRegistry::default();
        snapshots.acquire(5);

        let removed = gc_versions(&mut versions, &policy, &snapshots, 100);
        assert_eq!(removed, 0, "version protected by active snapshot");

        // Release the snapshot — now GC can remove it
        snapshots.release(5);
        let removed = gc_versions(&mut versions, &policy, &snapshots, 100);
        assert_eq!(removed, 1, "old version removed after snapshot released");
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].data, b"current");
    }
}
```

---

## Key Dependencies

| Crate | Purpose | Notes |
|-------|---------|-------|
| `rstar` 0.12 | R-tree spatial index | Bulk loading, envelope queries, KNN, `RTreeObject` trait |
| `geo` | Geospatial algorithms | Haversine, Vincenty, area, centroid, boolean ops (optional — for advanced use) |
| `geo-types` | Geometry primitives | `Point`, `LineString`, `Polygon`, `Rect` (optional — for `geo` interop) |
| `memmap2` 0.9 | Memory-mapped segment files | Read-only mmap for R-tree segment access |
| `byteorder` 1 | Endian-aware binary I/O | Serializing R-tree entries and temporal metadata |
| `parking_lot` 0.12 | Fast mutexes | Protecting version chains and snapshot registry |
| `crossbeam` 0.8 | Concurrent data structures | Lock-free channels for GC coordination |
| `proptest` 1 | Property-based testing | Random point generation, invariant verification |
