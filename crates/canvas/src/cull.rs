//! Which placements of a frame meet a rectangle, without looking at the others (ADR-007: every
//! cost per frame bounded by what is on screen, never by the note's length).
//!
//! An implicit tree of bounding boxes over the placements in their drawing order: a complete
//! binary tree whose leaves are the placements' boxes (surface px) and whose nodes are the unions
//! of their children. The pages are laid out in that order down the surface, so neighbouring
//! leaves are near each other and the nodes' boxes stay tight: a query visits the placements it
//! finds and the O(log n) nodes above them. A leaf changes in O(log n) (a page's scene arrives,
//! its ink reaching past the sheet).

/// x0, y0, x1, y1.
pub type Rect = [f32; 4];

/// A box nothing meets (a placement with nothing to draw yet).
pub const EMPTY: Rect = [
    f32::INFINITY,
    f32::INFINITY,
    f32::NEG_INFINITY,
    f32::NEG_INFINITY,
];

/// The smallest box holding both.
pub fn union(a: Rect, b: Rect) -> Rect {
    [
        a[0].min(b[0]),
        a[1].min(b[1]),
        a[2].max(b[2]),
        a[3].max(b[3]),
    ]
}

/// Whether two boxes share a point (edges included). Never true for `EMPTY`.
pub fn meets(a: &Rect, b: &Rect) -> bool {
    a[0] <= a[2] && a[1] <= a[3] && a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3]
}

#[derive(Clone, Debug, Default)]
pub struct BoxTree {
    n: usize,
    /// Leaves start here (a power of two, at least 1).
    base: usize,
    /// 1-based heap: node i has children 2i and 2i + 1; leaves at `base + i`.
    nodes: Vec<Rect>,
}

impl BoxTree {
    pub fn new(leaves: &[Rect]) -> Self {
        let n = leaves.len();
        let base = n.next_power_of_two().max(1);
        let mut nodes = vec![EMPTY; 2 * base];
        nodes[base..base + n].copy_from_slice(leaves);
        for i in (1..base).rev() {
            nodes[i] = union(nodes[2 * i], nodes[2 * i + 1]);
        }
        BoxTree { n, base, nodes }
    }

    pub fn len(&self) -> usize {
        self.n
    }

    pub fn is_empty(&self) -> bool {
        self.n == 0
    }

    pub fn get(&self, i: usize) -> Rect {
        if i < self.n {
            self.nodes[self.base + i]
        } else {
            EMPTY
        }
    }

    /// Leaf `i`'s new box; its ancestors follow (O(log n)).
    pub fn set(&mut self, i: usize, r: Rect) {
        if i >= self.n {
            return;
        }
        let mut k = self.base + i;
        if self.nodes[k] == r {
            return;
        }
        self.nodes[k] = r;
        while k > 1 {
            k /= 2;
            let u = union(self.nodes[2 * k], self.nodes[2 * k + 1]);
            if self.nodes[k] == u {
                break;
            }
            self.nodes[k] = u;
        }
    }

    /// The leaves meeting `r`, appended to `out` in ascending order (the drawing order).
    pub fn query(&self, r: &Rect, out: &mut Vec<usize>) {
        if self.n == 0 {
            return;
        }
        // Depth-first, left child first: leaves come out in order. The stack never holds more
        // than one node per level and side.
        let mut stack: [usize; 128] = [0; 128];
        let mut top = 0;
        stack[top] = 1;
        top += 1;
        while top > 0 {
            top -= 1;
            let k = stack[top];
            if !meets(&self.nodes[k], r) {
                continue;
            }
            if k >= self.base {
                out.push(k - self.base);
            } else {
                // Right pushed first so the left is visited first.
                stack[top] = 2 * k + 1;
                stack[top + 1] = 2 * k;
                top += 2;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn brute(leaves: &[Rect], r: &Rect) -> Vec<usize> {
        (0..leaves.len())
            .filter(|&i| meets(&leaves[i], r))
            .collect()
    }

    #[test]
    fn finds_exactly_the_leaves_a_brute_force_finds_in_order() {
        // Pages down a strip, papers then their ink (the frame's order), some ink reaching past
        // its sheet, some sheets without ink.
        let mut leaves = Vec::new();
        for i in 0..1000 {
            let t = i as f32 * 1064.0;
            leaves.push([0.0, t, 816.0, t + 1056.0]);
        }
        for i in 0..1000 {
            let t = i as f32 * 1064.0;
            leaves.push(match i % 7 {
                0 => EMPTY,
                3 => [-40.0, t - 300.0, 900.0, t + 2000.0],
                _ => [80.0, t + 60.0, 700.0, t + 900.0],
            });
        }
        let mut tree = BoxTree::new(&leaves);
        let mut seed = 7u64;
        let mut rnd = || {
            seed = seed
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (seed >> 33) as f32 / (1u64 << 31) as f32
        };
        for round in 0..400 {
            if round % 3 == 0 {
                let i = (rnd() * leaves.len() as f32) as usize % leaves.len();
                let t = rnd() * 1.06e6;
                leaves[i] = if rnd() < 0.2 {
                    EMPTY
                } else {
                    [0.0, t, 500.0, t + 50.0 + rnd() * 3000.0]
                };
                tree.set(i, leaves[i]);
            }
            let y = rnd() * 1.1e6 - 2e4;
            let r = [rnd() * 900.0 - 50.0, y, 900.0, y + rnd() * 4000.0];
            let mut got = Vec::new();
            tree.query(&r, &mut got);
            assert_eq!(got, brute(&leaves, &r), "round {round}");
        }
    }

    #[test]
    fn small_and_empty_trees() {
        let mut out = Vec::new();
        BoxTree::new(&[]).query(&[0.0, 0.0, 1.0, 1.0], &mut out);
        assert!(out.is_empty());
        let t = BoxTree::new(&[[0.0, 0.0, 10.0, 10.0]]);
        t.query(&[5.0, 5.0, 6.0, 6.0], &mut out);
        assert_eq!(out, vec![0]);
        out.clear();
        t.query(&[11.0, 5.0, 12.0, 6.0], &mut out);
        assert!(out.is_empty());
        assert!(!meets(
            &EMPTY,
            &[
                f32::NEG_INFINITY,
                f32::NEG_INFINITY,
                f32::INFINITY,
                f32::INFINITY
            ]
        ));
    }

    #[test]
    fn a_query_visits_what_it_finds_not_the_note() {
        // 20,000 placements: a screen's worth of query returns a handful.
        let leaves: Vec<Rect> = (0..20_000)
            .map(|i| {
                let t = i as f32 * 1064.0;
                [0.0, t, 816.0, t + 1056.0]
            })
            .collect();
        let tree = BoxTree::new(&leaves);
        let mut out = Vec::new();
        tree.query(&[0.0, 5.0e6, 816.0, 5.0e6 + 1366.0], &mut out);
        assert!(!out.is_empty() && out.len() <= 3, "{out:?}");
    }
}
