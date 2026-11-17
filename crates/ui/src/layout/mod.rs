//! Layout module: responsive shell, centered reading column, floating sidebar,
//! and platform-adaptive bottom action bars.

pub mod shell;

pub use shell::{
    BottomBarGeometry, FabGeometry, LayoutMode, LayoutShell, ReadingColumnGeometry,
    ShellGeometry, SidebarState,
};
