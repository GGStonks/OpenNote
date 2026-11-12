pub struct FlatBuffer<'a> {
    pub bytes: &'a [u8],
}

impl<'a> FlatBuffer<'a> {
    pub fn new(bytes: &'a [u8]) -> Self {
        Self { bytes }
    }

    fn ok(&self, at: usize, n: usize) -> bool {
        at + n <= self.bytes.len()
    }

    pub fn u8(&self, at: usize) -> Option<u8> {
        if self.ok(at, 1) {
            Some(self.bytes[at])
        } else {
            None
        }
    }

    pub fn u16(&self, at: usize) -> Option<u16> {
        if self.ok(at, 2) {
            Some(u16::from_le_bytes([self.bytes[at], self.bytes[at + 1]]))
        } else {
            None
        }
    }

    pub fn u32(&self, at: usize) -> Option<u32> {
        if self.ok(at, 4) {
            Some(u32::from_le_bytes([
                self.bytes[at],
                self.bytes[at + 1],
                self.bytes[at + 2],
                self.bytes[at + 3],
            ]))
        } else {
            None
        }
    }

    pub fn i32(&self, at: usize) -> Option<i32> {
        if self.ok(at, 4) {
            Some(i32::from_le_bytes([
                self.bytes[at],
                self.bytes[at + 1],
                self.bytes[at + 2],
                self.bytes[at + 3],
            ]))
        } else {
            None
        }
    }

    pub fn f32(&self, at: usize) -> Option<f32> {
        if self.ok(at, 4) {
            Some(f32::from_le_bytes([
                self.bytes[at],
                self.bytes[at + 1],
                self.bytes[at + 2],
                self.bytes[at + 3],
            ]))
        } else {
            None
        }
    }

    pub fn slice(&self, at: usize, n: usize) -> Option<&'a [u8]> {
        if self.ok(at, n) {
            Some(&self.bytes[at..at + n])
        } else {
            None
        }
    }

    pub fn root(&self) -> Option<usize> {
        self.u32(0).map(|u| u as usize)
    }

    pub fn field(&self, table: Option<usize>, slot: usize) -> Option<usize> {
        let t = table?;
        let back = self.i32(t)?;
        let vt = (t as isize - back as isize) as usize;
        let len = self.u16(vt)? as usize;
        if 4 + slot * 2 + 2 > len {
            return None;
        }
        let off = self.u16(vt + 4 + slot * 2)? as usize;
        if off != 0 {
            Some(t + off)
        } else {
            None
        }
    }

    pub fn r#ref(&self, table: Option<usize>, slot: usize) -> Option<usize> {
        let at = self.field(table, slot)?;
        let d = self.u32(at)? as usize;
        Some(at + d)
    }

    pub fn string(&self, table: Option<usize>, slot: usize) -> Option<String> {
        let b = self.bytes_of(table, slot, 1)?;
        String::from_utf8(b.to_vec()).ok()
    }

    pub fn bytes_of(&self, table: Option<usize>, slot: usize, size: usize) -> Option<&'a [u8]> {
        let v = self.r#ref(table, slot)?;
        let n = self.u32(v)? as usize;
        self.slice(v + 4, n * size)
    }

    pub fn tables(&self, table: Option<usize>, slot: usize) -> Vec<usize> {
        let v = match self.r#ref(table, slot) {
            Some(v) => v,
            None => return Vec::new(),
        };
        let n = match self.u32(v) {
            Some(n) => n as usize,
            None => return Vec::new(),
        };
        if !self.ok(v + 4, n * 4) {
            return Vec::new();
        }
        let mut out = Vec::with_capacity(n);
        for i in 0..n {
            let elem_loc = v + 4 + i * 4;
            if let Some(off) = self.u32(elem_loc) {
                out.push(elem_loc + off as usize);
            }
        }
        out
    }

    pub fn points(&self, table: Option<usize>, slot: usize) -> Vec<[f32; 2]> {
        let b = match self.bytes_of(table, slot, 8) {
            Some(b) => b,
            None => return Vec::new(),
        };
        let n = b.len() / 8;
        let mut out = Vec::with_capacity(n);
        for i in 0..n {
            let x = f32::from_le_bytes([b[i * 8], b[i * 8 + 1], b[i * 8 + 2], b[i * 8 + 3]]);
            let y = f32::from_le_bytes([
                b[i * 8 + 4],
                b[i * 8 + 5],
                b[i * 8 + 6],
                b[i * 8 + 7],
            ]);
            out.push([x, y]);
        }
        out
    }

    pub fn u8_at(&self, table: Option<usize>, slot: usize) -> Option<u8> {
        let at = self.field(table, slot)?;
        self.u8(at)
    }

    pub fn u32_at(&self, table: Option<usize>, slot: usize, plus: usize) -> Option<u32> {
        let at = self.field(table, slot)?;
        self.u32(at + plus)
    }

    pub fn f32_at(&self, table: Option<usize>, slot: usize, plus: usize) -> Option<f32> {
        let at = self.field(table, slot)?;
        let v = self.f32(at + plus)?;
        if v.is_finite() {
            Some(v)
        } else {
            None
        }
    }

    pub fn pair(&self, table: Option<usize>, slot: usize) -> Option<[f32; 2]> {
        let a = self.f32_at(table, slot, 0)?;
        let b = self.f32_at(table, slot, 4)?;
        Some([a, b])
    }

    pub fn rgba(&self, table: Option<usize>, slot: usize) -> Option<[u8; 4]> {
        let at = self.field(table, slot)?;
        let b = self.slice(at, 4)?;
        Some([b[0], b[1], b[2], b[3]])
    }
}

pub fn half(bits: u16) -> f64 {
    let sign = if bits & 0x8000 != 0 { -1.0 } else { 1.0 };
    let e = ((bits >> 10) & 0x1f) as i32;
    let f = (bits & 0x3ff) as f64;
    if e == 0 {
        return sign * f * 2.0f64.powi(-24);
    }
    if e == 31 {
        return if f != 0.0 {
            f64::NAN
        } else {
            sign * f64::INFINITY
        };
    }
    sign * (1.0 + f / 1024.0) * 2.0f64.powi(e - 15)
}
