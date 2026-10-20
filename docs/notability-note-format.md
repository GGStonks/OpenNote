# Notability `.note` file format (as read by OpenNote)

This describes the parts of a Notability note file that OpenNote's importer reads
(`src/import/notability.ts`). It describes data found in the file, for importing notes into
OpenNote. It is not a complete description of the format. Parts not listed here are not read.

## Container

A `.note` file is a ZIP archive holding one top-level folder:

| Entry | Content |
| --- | --- |
| `<name>/Session.plist` | The note: a binary property list holding a keyed archive (below). |
| `<name>/metadata.plist` | Note metadata (not read). |
| `<name>/Images/…`, `Assets/…`, `Media/…` | Pictures placed in the note (PNG, JPEG, GIF, HEIC, TIFF, WebP). |
| `<name>/PDFs/…` | PDF backgrounds (not imported). |
| `<name>/Recordings/…` | Audio recordings (`.m4a`, `.caf`, `.aac`, `.wav`; not imported). |
| thumbnails | Preview images (not read). |

ZIP entries are stored or deflated. If several `Session.plist` entries exist, the one with the
shortest path is used.

## Keyed archive

`Session.plist` is a keyed archive: a property list with `$objects` (a table of objects),
`$top` (the root) and references (`UID`) from one object to others. An object's class is named by
its `$class` entry. The root object is under `$top` as `root` or as `$0`. Arrays and sets are
stored as `NS.objects`, or as numbered keys `NS.object.0`, `NS.object.1`, and so on. Values used
below are numbers, strings, data (byte arrays), dates, arrays, dictionaries, and `NS.data`,
`NS.string` and `NS.time` wrappers around data, strings and dates.

### Root object

| Key | Meaning |
| --- | --- |
| `name` | Note title (string). |
| `creationDate` | Creation date (a date, or a wrapper with `NS.time`: seconds since 2001-01-01 UTC). |
| `richText` | The note's content (below). |

If `richText` is missing, the content object is the first object holding a
`Handwriting Overlay` key.

### Content object (`richText`)

| Key | Meaning |
| --- | --- |
| `Handwriting Overlay` | The ink: an object that leads to a curve store (below). |
| `attributedString` or `NBAttributedBackingString` | Typed text (below). |
| `mediaObjects` | Array of placed pictures and attachments (below). |
| `pdfFiles` | Array of PDF backgrounds. |
| `pageLayoutArray` | Array of page layouts, which may record the page size. |

Some object in the archive also holds `pageWidthInDocumentCoordsKey`: the page width in page
points. Without it, the importer assumes 537.6.

## Coordinates

Positions are in page points, with the origin at the top left of the first page. Pages are
`pageWidth` wide and stacked top to bottom with no gap. The page height follows from the page
layout's aspect ratio when one is recorded: a rectangle string `{{x, y}, {w, h}}`, or a size
string `{w, h}` with both values over 100. Otherwise the importer uses US Letter proportions.

## Ink: the curve store

The curve store is any archive object holding a `curvespoints` key. Normally there is one,
reached from the handwriting overlay. Its byte arrays are data values, sometimes wrapped as
`NS.data`, and every number in them is little-endian:

| Key | Type | Content |
| --- | --- | --- |
| `curvesnumpoints` | int32 per curve | N, the number of points in each curve. |
| `curvespoints` | float32 pairs | x, y of every point of every curve, curve after curve. |
| `curveswidth` | float32 per curve | The curve's base width (page points). Default 2. |
| `curvescolors` | 4 bytes per curve | R, G, B, A (0–255). Default opaque black. |
| `curvesstyles` | 1 byte per curve | The kind of curve (below). Default 3 (pen). |
| `curvesfractionalwidths` | float32 | Width factors, curve after curve (below). Default 1. |
| `shapes` | data | Recognised shapes (below). |
| `groupsArrays` | array | Grouped ink objects (not imported). |

The archive also stores the counts `numcurves`, `numpoints` and `numfractionalwidths`. The
importer derives them from the array lengths instead.

### Geometry of one curve

A curve of N points is a chain of cubic Bézier segments sharing their end points: points
0, 1, 2, 3 make the first segment (start, control, control, end), points 3, 4, 5, 6 the second,
and so on. If points are left over that do not make a whole segment, they are joined with
straight lines. A curve of one point is a dot.

A curve has `floor((N - 1) / 3) + 1` fractional widths, one for each segment end, read in order
from `curvesfractionalwidths`. The line's width at a segment end is
`curveswidth × fractional width`. Along a segment it changes linearly between the two ends. A
fractional width of 0 counts as 1.

### Curve kinds (`curvesstyles`)

| Value | Kind | Imported as |
| --- | --- | --- |
| 1 | selection | not imported |
| 2 | partial eraser | not imported |
| 3 | pen | pen stroke |
| 4 | highlighter | highlighter stroke |
| 5 | pencil | pen stroke |
| 6 | review | not imported |
| 7 | whole-object eraser | not imported |

Any other value is treated as pen.

## Shapes

The curve store's `shapes` value is a binary property list containing two arrays, `kinds` and
`shapes`, matched by index. Each shape is a dictionary whose fields are found by name at any depth:

| Kind | Shape | Fields |
| --- | --- | --- |
| 0 | line | `startPt` / `start`, `endPt` / `end`: points `[x, y]` |
| 1, 2 | rectangle | `corners` / `edges` / `points`: array of points |
| 3 | triangle | as above |
| 4 | polygon | as above |
| 5 | ellipse | `center` and `radius`, or `rect` `[[x, y], [w, h]]` |
| 6 | circle | as above |

Colour is under `rgba`, `strokeColor` or `color`, either as components (each 0–1, or 0–255 when
above 1) or as 4 bytes. The line width is `strokeWidth`, defaulting to 2.

## Typed text

The `attributedString` (or `NBAttributedBackingString`) value may wrap its content in
`NBAttributedBackingStringCodingKey`. The text is either the value's string or a dictionary's
`stringKey`. Object-replacement characters (U+FFFC) mark attachments and are removed. The
importer places the whole text in one text box at the top of the first page and does not read
its formatting.

## Pictures

For each entry of `mediaObjects`, the importer searches the object and the objects it refers to
for:

- a string ending in a file extension whose file name matches a ZIP entry under `Images/`,
  `Assets/` or `Media/`;
- the placement: a rectangle string `{{x, y}, {w, h}}`, or an origin string `{x, y}` (key
  containing "origin") together with a size string `{w, h}` (key containing "size"), in page
  points.

A picture with no placement is stacked at the top of the note, centred.
