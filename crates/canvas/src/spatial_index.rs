//! Spatial Index: High-performance 2D R-Tree for O(log n) viewport culling, hit-testing, and lasso queries.

use crate::geometry_engine::{RectBounds, Vec2d};

const MAX_CHILDREN: usize = 16;

#[derive(Clone, Debug)]
pub struct SpatialItem {
    pub id: String,
    pub bounds: RectBounds,
}

#[derive(Clone, Debug)]
enum NodeData {
    Leaf(Vec<SpatialItem>),
    Branch(Vec<(RectBounds, Box<RTreeNode>)>),
}

#[derive(Clone, Debug)]
struct RTreeNode {
    bounds: RectBounds,
    data: NodeData,
}

impl RTreeNode {
    fn new_leaf() -> Self {
        RTreeNode {
            bounds: RectBounds::default(),
            data: NodeData::Leaf(Vec::with_capacity(MAX_CHILDREN)),
        }
    }

    fn compute_bounds(&self) -> RectBounds {
        match &self.data {
            NodeData::Leaf(items) => {
                let mut b = RectBounds::default();
                for item in items {
                    b = b.union(&item.bounds);
                }
                b
            }
            NodeData::Branch(children) => {
                let mut b = RectBounds::default();
                for (cb, _) in children {
                    b = b.union(cb);
                }
                b
            }
        }
    }

    fn insert(&mut self, item: SpatialItem) -> Option<(RectBounds, Box<RTreeNode>)> {
        match &mut self.data {
            NodeData::Leaf(items) => {
                items.push(item);
                let count = items.len();
                if count > MAX_CHILDREN {
                    let (split_b, split_node) = self.split_leaf();
                    self.bounds = self.compute_bounds();
                    Some((split_b, split_node))
                } else {
                    self.bounds = self.compute_bounds();
                    None
                }
            }
            NodeData::Branch(children) => {
                let best_idx = pick_best_child(children, &item.bounds);
                let new_child = children[best_idx].1.insert(item);
                children[best_idx].0 = children[best_idx].1.bounds;
                if let Some(split) = new_child {
                    children.push(split);
                }
                let count = children.len();
                if count > MAX_CHILDREN {
                    let (split_b, split_node) = self.split_branch();
                    self.bounds = self.compute_bounds();
                    Some((split_b, split_node))
                } else {
                    self.bounds = self.compute_bounds();
                    None
                }
            }
        }
    }

    fn split_leaf(&mut self) -> (RectBounds, Box<RTreeNode>) {
        if let NodeData::Leaf(items) = &mut self.data {
            let mid = items.len() / 2;
            let right_items = items.split_off(mid);
            let mut right_node = RTreeNode {
                bounds: RectBounds::default(),
                data: NodeData::Leaf(right_items),
            };
            right_node.bounds = right_node.compute_bounds();
            (right_node.bounds, Box::new(right_node))
        } else {
            unreachable!()
        }
    }

    fn split_branch(&mut self) -> (RectBounds, Box<RTreeNode>) {
        if let NodeData::Branch(children) = &mut self.data {
            let mid = children.len() / 2;
            let right_children = children.split_off(mid);
            let mut right_node = RTreeNode {
                bounds: RectBounds::default(),
                data: NodeData::Branch(right_children),
            };
            right_node.bounds = right_node.compute_bounds();
            (right_node.bounds, Box::new(right_node))
        } else {
            unreachable!()
        }
    }

    fn remove(&mut self, id: &str) -> bool {
        match &mut self.data {
            NodeData::Leaf(items) => {
                if let Some(pos) = items.iter().position(|i| i.id == id) {
                    items.swap_remove(pos);
                    self.bounds = self.compute_bounds();
                    true
                } else {
                    false
                }
            }
            NodeData::Branch(children) => {
                let mut removed = false;
                for (b, child) in children.iter_mut() {
                    if child.remove(id) {
                        *b = child.bounds;
                        removed = true;
                        break;
                    }
                }
                if removed {
                    self.bounds = self.compute_bounds();
                }
                removed
            }
        }
    }

    fn query_intersects(&self, query_bounds: &RectBounds, out: &mut Vec<String>) {
        if !self.bounds.intersects(query_bounds) {
            return;
        }
        match &self.data {
            NodeData::Leaf(items) => {
                for item in items {
                    if item.bounds.intersects(query_bounds) {
                        out.push(item.id.clone());
                    }
                }
            }
            NodeData::Branch(children) => {
                for (_, child) in children {
                    child.query_intersects(query_bounds, out);
                }
            }
        }
    }
}

fn pick_best_child(children: &[(RectBounds, Box<RTreeNode>)], new_b: &RectBounds) -> usize {
    let mut best_idx = 0;
    let mut min_expansion = f64::INFINITY;
    for (i, (cb, _)) in children.iter().enumerate() {
        let area_before = cb.width() * cb.height();
        let union_b = cb.union(new_b);
        let area_after = union_b.width() * union_b.height();
        let expansion = area_after - area_before;
        if expansion < min_expansion {
            min_expansion = expansion;
            best_idx = i;
        }
    }
    best_idx
}

/// 2D Spatial Index using an R-Tree for high-frequency viewport culling and spatial operations.
#[derive(Clone, Debug)]
pub struct SpatialIndex {
    root: RTreeNode,
    count: usize,
}

impl Default for SpatialIndex {
    fn default() -> Self {
        SpatialIndex::new()
    }
}

impl SpatialIndex {
    pub fn new() -> Self {
        SpatialIndex {
            root: RTreeNode::new_leaf(),
            count: 0,
        }
    }

    #[inline]
    pub fn len(&self) -> usize {
        self.count
    }

    #[inline]
    pub fn is_empty(&self) -> bool {
        self.count == 0
    }

    pub fn insert(&mut self, id: String, bounds: RectBounds) {
        if let Some((split_b, split_node)) = self.root.insert(SpatialItem { id, bounds }) {
            let old_root_bounds = self.root.bounds;
            let old_root = std::mem::replace(&mut self.root, RTreeNode::new_leaf());
            self.root = RTreeNode {
                bounds: old_root_bounds.union(&split_b),
                data: NodeData::Branch(vec![
                    (old_root_bounds, Box::new(old_root)),
                    (split_b, split_node),
                ]),
            };
        }
        self.count += 1;
    }

    pub fn remove(&mut self, id: &str) -> bool {
        if self.root.remove(id) {
            self.count -= 1;
            true
        } else {
            false
        }
    }

    pub fn update(&mut self, id: String, bounds: RectBounds) {
        self.remove(&id);
        self.insert(id, bounds);
    }

    /// Queries all items whose bounding box intersects `bounds` (e.g. viewport frustum culling).
    pub fn query_intersects(&self, bounds: &RectBounds) -> Vec<String> {
        let mut out = Vec::new();
        self.root.query_intersects(bounds, &mut out);
        out
    }

    /// Queries all items within `radius` of a point (for hit-testing and circle eraser).
    pub fn query_radius(&self, center: Vec2d, radius: f64) -> Vec<String> {
        let query_box = RectBounds::new(
            center.x - radius,
            center.y - radius,
            center.x + radius,
            center.y + radius,
        );
        self.query_intersects(&query_box)
    }

    /// Queries items within `radius` of a continuous segment from `p1` to `p2` (for continuous erasing).
    pub fn query_segment(&self, p1: Vec2d, p2: Vec2d, radius: f64) -> Vec<String> {
        let min_x = p1.x.min(p2.x) - radius;
        let min_y = p1.y.min(p2.y) - radius;
        let max_x = p1.x.max(p2.x) + radius;
        let max_y = p1.y.max(p2.y) + radius;
        let seg_box = RectBounds::new(min_x, min_y, max_x, max_y);
        self.query_intersects(&seg_box)
    }

    /// Clears the index.
    pub fn clear(&mut self) {
        self.root = RTreeNode::new_leaf();
        self.count = 0;
    }
}
