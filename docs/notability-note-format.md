# Notability `.note` file format (as read by OpenNote)

This describes the parts of a Notability note file that OpenNote's importer reads
(`src/import/notability.ts`). It describes data found in the file, for importing notes into
OpenNote, as observed in notes written by Notability 7 to 16 (2018 to 2026). It is not a complete
description of the format.

## Container

A `.note` file is a ZIP archive holding one top-level folder:

| Entry | Content |
| --- | --- |
| `<name>/Session.plist` | The note: a binary property list holding a keyed archive (below). |
| `<name>/metadata.plist` | Note metadata (not read). |
| `<name>/Images/…` | Pictures placed in the note (JPEG, PNG). |
| `<name>/Assets/<id>/media.gif` | Animated pictures (a frame of each is also in `Images/`). |
| `<name>/PDFs/<file>.pdf` | PDFs the note's pages show. |
| `<name>/Recordings/library.plist`, `Recordings/*.m4a` | Audio recordings and their list (an XML property list). |
| `HandwritingIndex/`, `NBPDFIndex/`, thumbnails | Search indexes and previews (not read). |

ZIP entries are stored or deflated. If several `Session.plist` entries exist, the one with the
shortest path is used; its folder is the note's folder, and every file the note names is
relative to it (the folder's name is not always the note's).

## Keyed archive

`Session.plist` is a keyed archive: a property list with `$objects` (a table of objects),
`$top` (the root, under `$0` or `root`) and references (`UID`) from one object to others. An
object's class is named by its `$class` entry. Arrays and dictionaries come in two forms:
`NS.objects` (with `NS.keys` for dictionaries) or numbered keys `NS.object.0`, `NS.key.0`, … .
Strings are plain, or wrapped as `NS.string` / `NS.bytes`; dates are `NS.time` (seconds since
2001-01-01 UTC). Points, sizes and rectangles are strings: `{x, y}`, `{w, h}`, `{{x, y}, {w, h}}`.

### Root object

| Key | Meaning |
| --- | --- |
| `name` | Note title. |
| `creationDate` | Creation date. |
| `richText` | The note's content (below). |
| `paperIndex`, `paperLineStyle` | Paper of older notes: a paper texture number (below), and a line style (0: none). |
| `NBNoteTakingSessionDocumentPaperLayoutModelKey` | Newer notes: `documentPaperAttributes` (the paper) and `pageLayoutArray`. |

### Content object (`richText`)

| Key | Meaning |
| --- | --- |
| `Handwriting Overlay` | An object whose `SpatialHash` is the note's curve store (below). |
| `reflowState` | `pageWidthInDocumentCoordsKey`: the page width in document points (`W`). |
| `pdfFiles` | The PDFs: objects with `pdfFileName` and `version`. |
| `pageLayoutArray` | The pages, when the note has PDF pages or marked pages (below). |
| `mediaObjects` | Pictures, text boxes, stickies, formulas (below). |
| `attributedString` | Typed text of the note itself (below). |

Text boxes hold a content object of their own (`textStore`) with an empty curve store: the
note's ink is only the one under `Handwriting Overlay`.

## Coordinates and pages

The note is one tall surface in document points, `W` wide (565 on most iPads; 537.6, 574, 610,
679 and others occur). If `reflowState` has no width, the paper's `paperSizingBehavior`
(`lockedWidth:<W>:…`) gives it, else 565. x = 0 lies `W × 20/768` right of the page's left edge.
OpenNote's pages are 816 px wide: every position and width is scaled by 816 / W, after adding
that inset to x.

Pages are stacked top to bottom with no gap:

- A plain page is `1.3125 × W` high (`paperSizingBehavior` `staticWidth` with a `paperSize`: that
  paper's height for `W`, rounded down).
- `pageLayoutArray` lists pages in order. An entry whose `kPageLayoutPDFPageNumberKey` is under
  2³¹ − 1 is a page of a PDF: that page number (1-based; a note with a 0 counts from 0) of the
  file named by `kPageLayoutPDFFileNameKey`, or by the `pdfFileName` of its
  `kPageLayoutPDFFileKey`. The page is `W` wide and `ceil(h × W / w)` high (its PDF page `w × h`,
  rotation applied; `version` 1 files: `ceil(h × W / 612)`), the PDF page drawn in it. Any other
  entry (page number 2⁶³ − 1, or 2³¹ − 1 in old files) is a plain page.
- Content below the last listed page lies on plain pages.

### Paper

`documentPaperAttributes` (newer notes):

| Key | Meaning |
| --- | --- |
| `paperIdentifier` | `Color:#RRGGBB` (that colour), `Legacy:N` (paper texture N), `TemplatePDF:<id>:#RRGGBB` (every plain page shows `PDFs/<id>.pdf`). |
| `lineStyle2` | `No Lines`, or `Lines:<margin>:<…>:<spacing in inches>` (lines `spacing` apart, with a margin line when `<margin>` is `true`). |
| `paperSize`, `paperSizingBehavior` | See pages above. |

Older notes have `paperIndex`: paper texture `paperIndex + 1`. The textures (by number, as their
average colour): 1 #FCF9F4, 2 #FCF5C9, 3 #DADBED, 4 #D4EBCF, 5 #FCC0B6, 6 #E9DBB0, 7 #DFE9EC,
8 #717171, 9 #EFCDA2, 10 #88689B, 11 #5F4534, 12 #47454C, 13 white, 14 #000F46, 15 black.

## Ink: the curve store

Its byte arrays are data values (sometimes wrapped as `NS.data`), every number little-endian:

| Key | Type | Content |
| --- | --- | --- |
| `curvesnumpoints` | int32 per curve | N, the number of points in each curve. |
| `curvespoints` | float32 pairs | x, y of every point of every curve, curve after curve. |
| `curveswidth` | float32 per curve | The curve's base width (document points). |
| `curvescolors` | 4 bytes per curve | R, G, B, A (0–255). |
| `curvesstyles` | 1 byte per curve | The kind of curve (below). May be missing or shorter than the curves. |
| `curvesfractionalwidths` | float32 | Width factors, curve after curve (below). |
| `dashStyles` | data | A binary property list: `objectPatterns` maps a curve's index to `pattern` 1 (dashed) or 2 (dotted). |
| `shapes` | data | Recognised shapes (below). |
| `groupsArrays` | array of data | Grouped ink (below). |

### Geometry of one curve

A curve of N points is a chain of cubic Bézier segments sharing their end points: points
0, 1, 2, 3 make the first segment (start, control, control, end), points 3, 4, 5, 6 the second,
and so on. Points left over that do not make a whole segment are joined with straight lines. A
curve of one point is a dot.

A curve has `floor((N - 1) / 3) + 1` fractional widths, one for each segment end. The line's
width at a segment end is `curveswidth × fractional width`, linear along the segment. A fractional
width of 0 counts as 1.

### Curve kinds (`curvesstyles`)

| Value | Kind | Imported as |
| --- | --- | --- |
| 1 | selection | not imported |
| 2 | partial eraser | not imported |
| 3 | pen | pen stroke |
| 4 | highlighter | highlighter stroke (its colour's alpha is how see-through it is) |
| 5 | pencil | pen stroke |
| 6 | hidden | not imported |
| 7 | whole-object eraser | not imported |

A curve without a kind is a highlighter when its colour is see-through, else a pen.

## Shapes

The curve store's `shapes` value is a binary property list `{ shapes, kinds, indices }`, matched by
position. `indices` gives each shape's place among the curves (curves and shapes counted
together, in drawing order). `kinds` are names (numbers in older notes: 0 line, 1 square,
2 rectangle, 3 triangle, 4 polygon, 5 ellipse, 6 circle, 8 partialshape).

Every shape has `appearance`: `strokeColor` and optionally `fillColor` (`{ rgba: [r, g, b, a] }`,
components 0–1), `strokeWidth`, and `dashStyle` (`pattern` 1 dashed, 2 dotted; `arrowHead` 1: an
arrowhead at the end).

| Kind | Fields |
| --- | --- |
| `line` | `startPt`, `endPt` (`[x, y]`); with `controlPoint1`, a quadratic curve through that control point. |
| `rectangle`, `square`, `triangle`, `polygon` | `points` (corners), `isClosed`. |
| `circle`, `ellipse` | `rotatedRect.corners`: the four corners of the (turned) box it fills; else `rect` `[[x, y], [w, h]]`. |
| `partialshape` | A shape partly erased: `outlinePath`, its centre line, as path data (below). |

Path data: the bytes `25 b3 e5 48`, a uint32 count of elements, one byte per element (0 move to,
1 line to, 2 quadratic to, 3 cubic to, 4 close), then the elements' points as float64 x, y pairs
(1, 1, 2, 3 and 0 points). Each move starts a separate piece.

## Ink groups

Each `groupsArrays` value is a binary property list `{ inkGroup, index }`; `inkGroup` has
`inkGroupObjects` and `transform` (`[a, b, c, d, tx, ty]`: a point x, y is drawn at
`a·x + c·y + tx, b·x + d·y + ty`; widths scale by `√(a² + b²)`). An object of `type` 1 is a
keyed archive whose root is a curve store; of `type` 2, a shape list as above. `index` places the
group in the drawing order.

## Media objects

Common fields: `documentOrigin` (top-left corner), `unscaledContentSize` (size), `rotationDegrees`
(radians, clockwise about the centre, despite its name), `zIndex` (stacking order among media).
Media lie under the ink.

| Class | Read |
| --- | --- |
| `ImageMediaObject` | `figure.FigureBackgroundObjectKey.kImageObjectSnapshotKey.relativePath`: the picture's file. `figure.FigureCropRectKey`: the part shown (source pixels), applied when `figure.$0` holds data. `isFlippedHorizontal`, `isFlippedVertical`. `isGif` with `assetsIdKey`: `Assets/<id>/media.gif`. |
| `TextBlockMediaObject` | A text box: `textStore.attributedString` (below), `textStore.formattedStringTextAlignmentKey` (0 left, 1 centre, 2 right); text starts 5 points right and 2 points down of the box's corner. Its colour: `paperStyleObject.paperColor` (a UIColor: `UIRed`, `UIGreen`, `UIBlue`, `UIAlpha` 0–1, or `UIWhite`) or `kCanvasMediaObjectPaperAttributes.paperIdentifier` (`Color:#RRGGBB`); `cornerMode` 2: rounded corners. |
| `CanvasMediaObject` | A sticky note: its colour as for text boxes (its ink is in the curve store). |
| `MathMediaObject` | A formula: `latex` (LaTeX source), `color`. |

## Typed text

An attributed string is a dictionary `{ stringKey, subRangesKey }`: the text, and runs. Each run
has `subRangeRangeKey` (`{location, length}`, UTF-16 units), `subRangeFontKey`
(`NSFontNameAttribute`, a font's PostScript name: bold and italic are in the name;
`NSFontSizeAttribute`, points), `subRangeColorCrossPlatformKey` (`r,g,b,a`, 0–1) and
`subRangeOtherAttributesKey` (`NSUnderline`, `NSStrikethrough`, `indent-level`,
`indent-decoration-style`: 1 bullet, 2 numbered, 3 checklist; `indent-decoration-number`,
`checklist-checked`).

Numbered lists count `1.`, `A.`, `a.` by level. Lines are about 1.2 × the font size apart.

The note's own typed text (`richText.attributedString`) has no position: it flows from 3 points
below the top of the first page, `W × 20/768` from the left, each line taking a whole number of
the paper's line spacings when the paper has lines. It is often only empty lines.

## Recordings

`Recordings/library.plist` (an XML property list) has `recordings`: for each, `filepath` (a file
in `Recordings/`), `name`, `duration` (seconds) and `createddate`.
