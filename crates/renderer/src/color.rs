#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rgba {
    pub r: f32,
    pub g: f32,
    pub b: f32,
    pub a: f32,
}

impl Rgba {
    pub const WHITE: Self = Self { r: 1.0, g: 1.0, b: 1.0, a: 1.0 };
    pub const BLACK: Self = Self { r: 0.0, g: 0.0, b: 0.0, a: 1.0 };
    pub const TRANSPARENT: Self = Self { r: 0.0, g: 0.0, b: 0.0, a: 0.0 };

    pub fn new(r: f32, g: f32, b: f32, a: f32) -> Self {
        Self { r, g, b, a }
    }

    pub fn with_alpha(mut self, a: f32) -> Self {
        self.a = a;
        self
    }

    pub fn parse(s: &str, alpha: f32) -> Self {
        let s = s.trim();
        if s.starts_with('#') {
            let hex = &s[1..];
            if hex.len() == 6 {
                if let (Ok(r), Ok(g), Ok(b)) = (
                    u8::from_str_radix(&hex[0..2], 16),
                    u8::from_str_radix(&hex[2..4], 16),
                    u8::from_str_radix(&hex[4..6], 16),
                ) {
                    return Self {
                        r: r as f32 / 255.0,
                        g: g as f32 / 255.0,
                        b: b as f32 / 255.0,
                        a: alpha,
                    };
                }
            } else if hex.len() == 3 {
                if let (Ok(r), Ok(g), Ok(b)) = (
                    u8::from_str_radix(&hex[0..1], 16),
                    u8::from_str_radix(&hex[1..2], 16),
                    u8::from_str_radix(&hex[2..3], 16),
                ) {
                    return Self {
                        r: (r * 17) as f32 / 255.0,
                        g: (g * 17) as f32 / 255.0,
                        b: (b * 17) as f32 / 255.0,
                        a: alpha,
                    };
                }
            }
        } else if s.starts_with("rgb") {
            // parse rgb(r, g, b) or rgba(r, g, b, a)
            let inside = s.trim_start_matches("rgba(").trim_start_matches("rgb(").trim_end_matches(')');
            let parts: Vec<&str> = inside.split(',').collect();
            if parts.len() >= 3 {
                let r: f32 = parts[0].trim().parse().unwrap_or(0.0);
                let g: f32 = parts[1].trim().parse().unwrap_or(0.0);
                let b: f32 = parts[2].trim().parse().unwrap_or(0.0);
                let mut a = alpha;
                if parts.len() >= 4 {
                    if let Ok(parsed_a) = parts[3].trim().parse::<f32>() {
                        a *= parsed_a;
                    }
                }
                return Self {
                    r: r / 255.0,
                    g: g / 255.0,
                    b: b / 255.0,
                    a,
                };
            }
        }

        // Named paper colors fallback
        match s {
            "white" => Self::WHITE.with_alpha(alpha),
            "cream" => Self::parse("#FBF7EE", alpha),
            "yellow" => Self::parse("#FEF9C3", alpha),
            "ochre" => Self::parse("#F1DFAE", alpha),
            "blue" => Self::parse("#E6F0FB", alpha),
            "green" => Self::parse("#E8F4E5", alpha),
            "pink" => Self::parse("#FBE7EE", alpha),
            "gray" => Self::parse("#EDEDED", alpha),
            "dark" => Self::parse("#1C1C1F", alpha),
            _ => Self::BLACK.with_alpha(alpha),
        }
    }

    #[inline]
    pub fn to_u8_array(self) -> [u8; 4] {
        [
            (self.r.clamp(0.0, 1.0) * 255.0).round() as u8,
            (self.g.clamp(0.0, 1.0) * 255.0).round() as u8,
            (self.b.clamp(0.0, 1.0) * 255.0).round() as u8,
            (self.a.clamp(0.0, 1.0) * 255.0).round() as u8,
        ]
    }
}

