import React, { useRef, useEffect, useState, useCallback } from 'react';
import { Stroke, Point, ToolType, PaperStyle, PaperColor, LatexBlock } from '../types';
import { drawStroke } from '../ink/strokeSmoother';
import { renderLatexToHtml } from '../services/latexService';
import { compileTikzToSvg } from '../services/tikzService';
import {
  isPointInPolygon,
  detectShapeFromStroke,
  convertStrokesToTikzDocument
} from '../services/shapeRecognition';
import {
  Sparkles, Trash2, Copy, Move, Share2, Shapes, Palette, Check,
  CornerDownRight, Download, Maximize2
} from 'lucide-react';

interface CanvasPageProps {
  pageId: string;
  pageNumber: number;
  strokes: Stroke[];
  latexBlocks: LatexBlock[];
  activeTool: ToolType;
  penColor: string;
  penWidth: number;
  highlighterColor: string;
  paperStyle: PaperStyle;
  paperColor: PaperColor;
  stylusOnlyMode: boolean;
  onAddStroke: (stroke: Stroke) => void;
  onDeleteStroke: (strokeId: string) => void;
  onUpdateStrokes: (strokes: Stroke[]) => void;
  onAddLatexBlock: (block: LatexBlock) => void;
  onUpdateLatexBlock: (block: LatexBlock) => void;
  onDeleteLatexBlock: (blockId: string) => void;
  onTriggerRegionLatexConvert: (
    croppedImageBase64: string,
    bounds: { x: number; y: number; width: number; height: number },
    mode: 'math' | 'tikz'
  ) => void;
}

const PAGE_WIDTH = 816;
const PAGE_HEIGHT = 1056;

export const CanvasPage: React.FC<CanvasPageProps> = ({
  pageId,
  pageNumber,
  strokes,
  latexBlocks,
  activeTool,
  penColor,
  penWidth,
  highlighterColor,
  paperStyle,
  paperColor,
  stylusOnlyMode,
  onAddStroke,
  onDeleteStroke,
  onUpdateStrokes,
  onAddLatexBlock,
  onUpdateLatexBlock,
  onDeleteLatexBlock,
  onTriggerRegionLatexConvert,
}) => {
  const bgCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const strokeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const activeCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const [isDrawing, setIsDrawing] = useState(false);
  const currentPoints = useRef<Point[]>([]);

  // Advanced Lasso Selection State (PDEDraw + Notability Architecture)
  const [lassoPolygon, setLassoPolygon] = useState<Point[]>([]);
  const [selectedStrokeIds, setSelectedStrokeIds] = useState<string[]>([]);
  const [selectedBlockIds, setSelectedBlockIds] = useState<string[]>([]);
  const [selectionBounds, setSelectionBounds] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);

  // Lasso Transform / Dragging State
  const [isDraggingSelection, setIsDraggingSelection] = useState(false);
  const [isScalingSelection, setIsScalingSelection] = useState(false);
  const dragAnchor = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const originalStrokesRef = useRef<Stroke[]>([]);
  const originalBlocksRef = useRef<LatexBlock[]>([]);
  const originalBoundsRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);

  // Transparent LaTeX Block Selection / Dragging State
  const [activeBlockId, setActiveBlockId] = useState<string | null>(null);
  const [draggingBlockId, setDraggingBlockId] = useState<string | null>(null);
  const blockDragStartOffset = useRef<{ offsetX: number; offsetY: number }>({ offsetX: 0, offsetY: 0 });

  // Setup HiDPI Canvas with clean transform reset
  const setupCanvas = useCallback((canvas: HTMLCanvasElement) => {
    const dpr = window.devicePixelRatio || 2;
    canvas.width = PAGE_WIDTH * dpr;
    canvas.height = PAGE_HEIGHT * dpr;
    canvas.style.width = `${PAGE_WIDTH}px`;
    canvas.style.height = `${PAGE_HEIGHT}px`;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }, []);

  // Initialize all canvases including activeCanvasRef on mount/resize
  useEffect(() => {
    if (bgCanvasRef.current) setupCanvas(bgCanvasRef.current);
    if (strokeCanvasRef.current) setupCanvas(strokeCanvasRef.current);
    if (activeCanvasRef.current) setupCanvas(activeCanvasRef.current);
  }, [setupCanvas]);

  // Render Paper Background
  useEffect(() => {
    const canvas = bgCanvasRef.current;
    if (!canvas) return;
    setupCanvas(canvas);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const colors: Record<PaperColor, string> = {
      white: '#FFFFFF',
      cream: '#FDFBF7',
      yellow: '#FEF9C3',
      dark: '#18181B',
    };

    ctx.fillStyle = colors[paperColor];
    ctx.fillRect(0, 0, PAGE_WIDTH, PAGE_HEIGHT);

    const isDark = paperColor === 'dark';
    const gridLineColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
    const ruledLineColor = isDark ? 'rgba(255,255,255,0.12)' : 'rgba(59,130,246,0.18)';
    const marginLineColor = isDark ? 'rgba(239,68,68,0.25)' : 'rgba(239,68,68,0.35)';

    if (paperStyle === 'ruled') {
      const lineSpacing = 32;
      const topMargin = 80;
      ctx.lineWidth = 1;

      // Vertical left margin line (Notability red margin rule)
      ctx.strokeStyle = marginLineColor;
      ctx.beginPath();
      ctx.moveTo(80, 0);
      ctx.lineTo(80, PAGE_HEIGHT);
      ctx.stroke();

      // Horizontal ruled lines
      ctx.strokeStyle = ruledLineColor;
      for (let y = topMargin; y < PAGE_HEIGHT - 20; y += lineSpacing) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(PAGE_WIDTH, y);
        ctx.stroke();
      }
    } else if (paperStyle === 'grid') {
      const gridSize = 24;
      ctx.strokeStyle = gridLineColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x < PAGE_WIDTH; x += gridSize) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, PAGE_HEIGHT);
      }
      for (let y = 0; y < PAGE_HEIGHT; y += gridSize) {
        ctx.moveTo(0, y);
        ctx.lineTo(PAGE_WIDTH, y);
      }
      ctx.stroke();
    } else if (paperStyle === 'dots') {
      const dotSpacing = 24;
      ctx.fillStyle = isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.15)';
      for (let x = dotSpacing; x < PAGE_WIDTH; x += dotSpacing) {
        for (let y = dotSpacing; y < PAGE_HEIGHT; y += dotSpacing) {
          ctx.beginPath();
          ctx.arc(x, y, 1.2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }, [paperStyle, paperColor, setupCanvas]);

  // Render Committed Strokes
  useEffect(() => {
    const canvas = strokeCanvasRef.current;
    if (!canvas) return;
    setupCanvas(canvas);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, PAGE_WIDTH, PAGE_HEIGHT);

    // 1. Draw Highlighters first
    strokes.filter(s => s.tool === 'highlighter').forEach(s => {
      drawStroke(ctx, s.points, s.color, s.width, s.opacity, true, s.lineStyle);
    });

    // 2. Draw Pens
    strokes.filter(s => s.tool === 'pen').forEach(s => {
      drawStroke(ctx, s.points, s.color, s.width, s.opacity, false, s.lineStyle);
    });
  }, [strokes, setupCanvas]);

  // Coordinate normalizer mapping client events 1:1 to canvas coordinates
  const getCanvasCoords = (e: React.PointerEvent<HTMLCanvasElement>): Point => {
    const rect = e.currentTarget.getBoundingClientRect();
    const scaleX = PAGE_WIDTH / rect.width;
    const scaleY = PAGE_HEIGHT / rect.height;
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;
    const pressure = e.pointerType === 'pen' ? (e.pressure || 0.5) : 0.5;
    return { x, y, pressure };
  };

  // Pointer Down
  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (activeTool === 'hand') return;

    // Palm Rejection: reject finger touch when stylus-only mode is active
    if (stylusOnlyMode && e.pointerType === 'touch') {
      return;
    }

    // Dismiss active selections if clicking outside
    if (activeTool !== 'lasso') {
      setSelectedStrokeIds([]);
      setSelectedBlockIds([]);
      setSelectionBounds(null);
      setActiveBlockId(null);
    }

    e.currentTarget.setPointerCapture(e.pointerId);
    const pt = getCanvasCoords(e);

    setIsDrawing(true);
    currentPoints.current = [pt];

    if (activeTool === 'eraser') {
      eraseAtPoint(pt.x, pt.y);
    } else if (activeTool === 'lasso') {
      // Start freehand lasso path
      setLassoPolygon([pt]);
      setSelectedStrokeIds([]);
      setSelectedBlockIds([]);
      setSelectionBounds(null);
    }
  };

  // Pointer Move
  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawing) return;
    if (stylusOnlyMode && e.pointerType === 'touch') return;

    const rect = e.currentTarget.getBoundingClientRect();
    const scaleX = PAGE_WIDTH / rect.width;
    const scaleY = PAGE_HEIGHT / rect.height;

    const coalescedEvents = (e.nativeEvent as any).getCoalescedEvents
      ? (e.nativeEvent as any).getCoalescedEvents()
      : [e.nativeEvent];

    for (const ce of coalescedEvents) {
      const x = (ce.clientX - rect.left) * scaleX;
      const y = (ce.clientY - rect.top) * scaleY;
      const pressure = e.pointerType === 'pen' ? (ce.pressure || 0.5) : 0.5;
      const pt = { x, y, pressure };
      currentPoints.current.push(pt);

      if (activeTool === 'eraser') {
        eraseAtPoint(x, y);
      } else if (activeTool === 'lasso') {
        setLassoPolygon(prev => [...prev, pt]);
      }
    }

    // Live preview on activeCanvasRef
    const activeCanvas = activeCanvasRef.current;
    if (activeCanvas) {
      const ctx = activeCanvas.getContext('2d');
      if (ctx) {
        ctx.clearRect(0, 0, PAGE_WIDTH, PAGE_HEIGHT);

        if (activeTool === 'pen' || activeTool === 'highlighter') {
          drawStroke(
            ctx,
            currentPoints.current,
            activeTool === 'pen' ? penColor : highlighterColor,
            activeTool === 'pen' ? penWidth : 4,
            activeTool === 'pen' ? 1.0 : 0.4,
            activeTool === 'highlighter'
          );
        } else if (activeTool === 'lasso') {
          // Render dashed lasso loop
          ctx.save();
          ctx.strokeStyle = '#3B82F6';
          ctx.lineWidth = 1.8;
          ctx.setLineDash([6, 6]);
          ctx.fillStyle = 'rgba(59, 130, 246, 0.08)';
          ctx.beginPath();
          if (currentPoints.current.length > 0) {
            ctx.moveTo(currentPoints.current[0].x, currentPoints.current[0].y);
            for (let i = 1; i < currentPoints.current.length; i++) {
              ctx.lineTo(currentPoints.current[i].x, currentPoints.current[i].y);
            }
            ctx.stroke();
            ctx.fill();
          }
          ctx.restore();
        }
      }
    }
  };

  // Pointer Up
  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawing) return;
    setIsDrawing(false);

    const activeCanvas = activeCanvasRef.current;
    if (activeCanvas) {
      const ctx = activeCanvas.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, PAGE_WIDTH, PAGE_HEIGHT);
    }

    if (activeTool === 'pen' || activeTool === 'highlighter') {
      if (currentPoints.current.length > 0) {
        const newStroke: Stroke = {
          id: `stroke_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
          tool: activeTool,
          color: activeTool === 'pen' ? penColor : highlighterColor,
          width: activeTool === 'pen' ? penWidth : 4,
          opacity: activeTool === 'pen' ? 1.0 : 0.4,
          points: [...currentPoints.current],
          lineStyle: 'solid'
        };
        onAddStroke(newStroke);
      }
    } else if (activeTool === 'lasso') {
      const poly = currentPoints.current;
      if (poly.length > 3) {
        // Evaluate which strokes and latex blocks are enclosed in lasso
        const enclosedStrokeIds: string[] = [];
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

        strokes.forEach(s => {
          // Check if any point or centroid is inside polygon
          const pointsInside = s.points.filter(p => isPointInPolygon(p, poly));
          if (pointsInside.length > s.points.length * 0.35 || pointsInside.length >= 3) {
            enclosedStrokeIds.push(s.id);
            s.points.forEach(p => {
              minX = Math.min(minX, p.x);
              maxX = Math.max(maxX, p.x);
              minY = Math.min(minY, p.y);
              maxY = Math.max(maxY, p.y);
            });
          }
        });

        const enclosedBlockIds: string[] = [];
        latexBlocks.forEach(b => {
          const center = { x: b.x + b.width / 2, y: b.y + b.height / 2, pressure: 0.5 };
          if (isPointInPolygon(center, poly)) {
            enclosedBlockIds.push(b.id);
            minX = Math.min(minX, b.x);
            maxX = Math.max(maxX, b.x + b.width);
            minY = Math.min(minY, b.y);
            maxY = Math.max(maxY, b.y + b.height);
          }
        });

        if (enclosedStrokeIds.length > 0 || enclosedBlockIds.length > 0) {
          const pad = 12;
          setSelectedStrokeIds(enclosedStrokeIds);
          setSelectedBlockIds(enclosedBlockIds);
          setSelectionBounds({
            x: Math.max(0, minX - pad),
            y: Math.max(0, minY - pad),
            width: Math.min(PAGE_WIDTH - minX, maxX - minX + pad * 2),
            height: Math.min(PAGE_HEIGHT - minY, maxY - minY + pad * 2),
          });
        } else {
          setSelectedStrokeIds([]);
          setSelectedBlockIds([]);
          setSelectionBounds(null);
        }
      }
    }

    currentPoints.current = [];
  };

  // Stroke Eraser
  const eraseAtPoint = (x: number, y: number) => {
    const eraserRadius = 18;
    strokes.forEach(stroke => {
      for (const p of stroke.points) {
        const dist = Math.hypot(p.x - x, p.y - y);
        if (dist <= eraserRadius) {
          onDeleteStroke(stroke.id);
          break;
        }
      }
    });
  };

  // --- LASSO TRANSFORMATIONS (Move, Scale, Duplicate, Delete, Snap Shape) ---

  const handleLassoMoveStart = (e: React.PointerEvent) => {
    e.stopPropagation();
    if (!selectionBounds) return;
    setIsDraggingSelection(true);
    dragAnchor.current = { x: e.clientX, y: e.clientY };
    originalStrokesRef.current = JSON.parse(JSON.stringify(strokes));
    originalBlocksRef.current = JSON.parse(JSON.stringify(latexBlocks));
    originalBoundsRef.current = { ...selectionBounds };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handleLassoMove = (e: React.PointerEvent) => {
    if (!isDraggingSelection || !selectionBounds || !originalBoundsRef.current) return;
    e.stopPropagation();

    const dx = e.clientX - dragAnchor.current.x;
    const dy = e.clientY - dragAnchor.current.y;

    // Update selection bounds position
    setSelectionBounds({
      ...originalBoundsRef.current,
      x: originalBoundsRef.current.x + dx,
      y: originalBoundsRef.current.y + dy,
    });

    // Translate selected strokes
    const updatedStrokes = originalStrokesRef.current.map(s => {
      if (!selectedStrokeIds.includes(s.id)) return s;
      return {
        ...s,
        points: s.points.map(p => ({ ...p, x: p.x + dx, y: p.y + dy })),
      };
    });
    onUpdateStrokes(updatedStrokes);

    // Translate selected latex blocks
    originalBlocksRef.current.forEach(b => {
      if (selectedBlockIds.includes(b.id)) {
        onUpdateLatexBlock({
          ...b,
          x: b.x + dx,
          y: b.y + dy,
        });
      }
    });
  };

  const handleLassoMoveEnd = (e: React.PointerEvent) => {
    if (isDraggingSelection) {
      setIsDraggingSelection(false);
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    }
  };

  // Scale selected strokes via corner handle
  const handleLassoScaleStart = (e: React.PointerEvent) => {
    e.stopPropagation();
    if (!selectionBounds) return;
    setIsScalingSelection(true);
    dragAnchor.current = { x: e.clientX, y: e.clientY };
    originalStrokesRef.current = JSON.parse(JSON.stringify(strokes));
    originalBoundsRef.current = { ...selectionBounds };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handleLassoScale = (e: React.PointerEvent) => {
    if (!isScalingSelection || !originalBoundsRef.current) return;
    e.stopPropagation();

    const dx = e.clientX - dragAnchor.current.x;
    const origW = originalBoundsRef.current.width;
    const origH = originalBoundsRef.current.height;
    const scaleFactor = Math.max(0.3, Math.min(3.0, (origW + dx) / origW));

    const cx = originalBoundsRef.current.x;
    const cy = originalBoundsRef.current.y;

    setSelectionBounds({
      x: cx,
      y: cy,
      width: origW * scaleFactor,
      height: origH * scaleFactor,
    });

    const scaledStrokes = originalStrokesRef.current.map(s => {
      if (!selectedStrokeIds.includes(s.id)) return s;
      return {
        ...s,
        points: s.points.map(p => ({
          ...p,
          x: cx + (p.x - cx) * scaleFactor,
          y: cy + (p.y - cy) * scaleFactor,
        })),
      };
    });
    onUpdateStrokes(scaledStrokes);
  };

  const handleLassoScaleEnd = (e: React.PointerEvent) => {
    if (isScalingSelection) {
      setIsScalingSelection(false);
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    }
  };

  // Snap to Geometric Shape (PDEDraw Auto-Shape)
  const handleSnapToShape = () => {
    if (selectedStrokeIds.length === 0) return;
    const updated = strokes.map(s => {
      if (!selectedStrokeIds.includes(s.id)) return s;
      const detected = detectShapeFromStroke(s, PAGE_HEIGHT);
      return {
        ...s,
        points: detected.points,
      };
    });
    onUpdateStrokes(updated);
  };

  // Recolor selected strokes
  const handleRecolorSelection = (color: string) => {
    const updated = strokes.map(s => {
      if (!selectedStrokeIds.includes(s.id)) return s;
      return { ...s, color };
    });
    onUpdateStrokes(updated);
  };

  // Toggle line style: solid -> dashed -> dotted
  const handleToggleLineStyle = (style: 'solid' | 'dashed' | 'dotted') => {
    const updated = strokes.map(s => {
      if (!selectedStrokeIds.includes(s.id)) return s;
      return { ...s, lineStyle: style };
    });
    onUpdateStrokes(updated);
  };

  // Duplicate selected strokes
  const handleDuplicateSelection = () => {
    const offset = 24;
    const duplicated: Stroke[] = strokes
      .filter(s => selectedStrokeIds.includes(s.id))
      .map(s => ({
        ...s,
        id: `stroke_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
        points: s.points.map(p => ({ x: p.x + offset, y: p.y + offset, pressure: p.pressure })),
      }));

    onUpdateStrokes([...strokes, ...duplicated]);
    if (selectionBounds) {
      setSelectionBounds({
        ...selectionBounds,
        x: selectionBounds.x + offset,
        y: selectionBounds.y + offset,
      });
      setSelectedStrokeIds(duplicated.map(d => d.id));
    }
  };

  // Delete selected strokes
  const handleDeleteSelection = () => {
    selectedStrokeIds.forEach(id => onDeleteStroke(id));
    selectedBlockIds.forEach(id => onDeleteLatexBlock(id));
    setSelectedStrokeIds([]);
    setSelectedBlockIds([]);
    setSelectionBounds(null);
  };

  // Convert selected strokes to LaTeX Math or TikZ
  const handleTriggerConvert = (mode: 'math' | 'tikz') => {
    if (!selectionBounds || !strokeCanvasRef.current) return;

    // 1. If TikZ mode and we have selected strokes, generate TikZ immediately
    if (mode === 'tikz') {
      const selectedStrokes = strokes.filter(s => selectedStrokeIds.includes(s.id));
      if (selectedStrokes.length > 0) {
        const tikzDoc = convertStrokesToTikzDocument(selectedStrokes, PAGE_HEIGHT);
        // Create transparent vector TikZ block directly on the note
        const newBlock: LatexBlock = {
          id: `tikz_${Date.now()}`,
          x: selectionBounds.x,
          y: selectionBounds.y,
          width: Math.max(260, selectionBounds.width),
          height: Math.max(160, selectionBounds.height),
          latexCode: tikzDoc,
          isTikz: true,
          createdAt: Date.now(),
        };
        onAddLatexBlock(newBlock);
        // Delete the handwritten strokes so they are replaced by the transparent vector graphic
        selectedStrokeIds.forEach(id => onDeleteStroke(id));
        setSelectedStrokeIds([]);
        setSelectionBounds(null);
        return;
      }
    }

    // 2. For Math or VLM transcription, crop image for VLM
    const offscreen = document.createElement('canvas');
    offscreen.width = selectionBounds.width;
    offscreen.height = selectionBounds.height;
    const offCtx = offscreen.getContext('2d');
    if (!offCtx) return;

    offCtx.fillStyle = '#FFFFFF';
    offCtx.fillRect(0, 0, selectionBounds.width, selectionBounds.height);

    const dpr = window.devicePixelRatio || 2;
    offCtx.drawImage(
      strokeCanvasRef.current,
      selectionBounds.x * dpr,
      selectionBounds.y * dpr,
      selectionBounds.width * dpr,
      selectionBounds.height * dpr,
      0,
      0,
      selectionBounds.width,
      selectionBounds.height
    );

    const croppedBase64 = offscreen.toDataURL('image/png');
    onTriggerRegionLatexConvert(croppedBase64, selectionBounds, mode);
    setSelectedStrokeIds([]);
    setSelectionBounds(null);
  };

  // --- TRANSPARENT VECTOR SVG BLOCK DRAGGING ---

  const handleBlockDragStart = (e: React.PointerEvent, block: LatexBlock) => {
    e.stopPropagation();
    setActiveBlockId(block.id);
    setDraggingBlockId(block.id);
    blockDragStartOffset.current = {
      offsetX: e.clientX - block.x,
      offsetY: e.clientY - block.y,
    };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handleBlockDragMove = (e: React.PointerEvent, block: LatexBlock) => {
    if (draggingBlockId !== block.id) return;
    e.stopPropagation();
    const newX = Math.max(10, Math.min(PAGE_WIDTH - 60, e.clientX - blockDragStartOffset.current.offsetX));
    const newY = Math.max(10, Math.min(PAGE_HEIGHT - 40, e.clientY - blockDragStartOffset.current.offsetY));
    onUpdateLatexBlock({
      ...block,
      x: newX,
      y: newY,
    });
  };

  const handleBlockDragEnd = (e: React.PointerEvent) => {
    if (draggingBlockId) {
      setDraggingBlockId(null);
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    }
  };

  return (
    <div className="relative mb-8 flex justify-center select-none">
      <div
        className="relative bg-white shadow-2xl rounded-sm overflow-hidden border border-gray-300 dark:border-gray-800"
        style={{ width: `${PAGE_WIDTH}px`, height: `${PAGE_HEIGHT}px` }}
      >
        {/* Layer 1: Paper Background */}
        <canvas ref={bgCanvasRef} className="absolute inset-0 pointer-events-none" />

        {/* Layer 2: Committed Ink Strokes */}
        <canvas ref={strokeCanvasRef} className="absolute inset-0 pointer-events-none" />

        {/* Layer 3: Interactive Drawing / Stylus Canvas */}
        <canvas
          ref={activeCanvasRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          className="absolute inset-0 cursor-crosshair touch-none"
        />

        {/* Layer 4: Transparent Vector SVG Math & TikZ Blocks (NO WINDOW FRAME, PURE VECTOR) */}
        {latexBlocks.map(block => {
          const isSelected = activeBlockId === block.id;

          // Pure vector SVG or transparent KaTeX
          const contentSvg = block.isTikz
            ? compileTikzToSvg(block.latexCode, block.width, block.height)
            : renderLatexToHtml(block.latexCode);

          return (
            <div
              key={block.id}
              onClick={(e) => {
                e.stopPropagation();
                setActiveBlockId(block.id);
              }}
              className={`absolute select-none touch-none z-20 group transition-all duration-75 ${
                isSelected
                  ? 'ring-2 ring-blue-500/80 ring-offset-2 ring-offset-transparent'
                  : 'hover:ring-1 hover:ring-blue-400/40'
              }`}
              style={{
                left: `${block.x}px`,
                top: `${block.y}px`,
                width: `${block.width}px`,
                height: `${block.height}px`,
                background: 'transparent',
              }}
            >
              {/* Minimalist Floating Action Pill (Visible on selection or hover) */}
              {isSelected && (
                <div
                  className="absolute -top-10 left-1/2 -translate-x-1/2 flex items-center space-x-1.5 bg-gray-900/90 dark:bg-[#1C1C1E]/95 text-white px-2.5 py-1 rounded-full shadow-xl text-xs z-30 backdrop-blur-md"
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  <button
                    onPointerDown={(e) => handleBlockDragStart(e, block)}
                    onPointerMove={(e) => handleBlockDragMove(e, block)}
                    onPointerUp={handleBlockDragEnd}
                    className="p-1 hover:text-blue-400 cursor-grab active:cursor-grabbing rounded"
                    title="Move Vector Block"
                  >
                    <Move className="w-3.5 h-3.5" />
                  </button>
                  <div className="w-[1px] h-3 bg-gray-600" />
                  <button
                    onClick={() => navigator.clipboard.writeText(block.latexCode)}
                    className="p-1 hover:text-blue-400 rounded"
                    title="Copy LaTeX / TikZ Source"
                  >
                    <Copy className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => onDeleteLatexBlock(block.id)}
                    className="p-1 hover:text-red-400 rounded"
                    title="Delete Vector Block"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}

              {/* Move Handle (Top-left corner indicator on selection) */}
              {isSelected && (
                <div
                  onPointerDown={(e) => handleBlockDragStart(e, block)}
                  onPointerMove={(e) => handleBlockDragMove(e, block)}
                  onPointerUp={handleBlockDragEnd}
                  className="absolute -top-2.5 -left-2.5 w-5 h-5 bg-blue-600 text-white rounded-full flex items-center justify-center cursor-grab active:cursor-grabbing shadow-md z-30"
                >
                  <Move className="w-3 h-3" />
                </div>
              )}

              {/* Pure Transparent Vector SVG Graphic Content */}
              {block.isTikz ? (
                <div
                  className="w-full h-full flex items-center justify-center overflow-visible pointer-events-none"
                  dangerouslySetInnerHTML={{ __html: contentSvg }}
                />
              ) : (
                <div
                  className="w-full h-full flex items-center justify-center text-gray-900 dark:text-gray-100 text-xl font-serif pointer-events-none"
                  style={{ background: 'transparent' }}
                  dangerouslySetInnerHTML={{ __html: contentSvg }}
                />
              )}
            </div>
          );
        })}

        {/* Layer 5: Advanced Lasso Selection Bounding Box & Floating Toolbar (PDEDraw Architecture) */}
        {selectionBounds && (
          <div
            className="absolute border-2 border-dashed border-blue-500 bg-blue-500/5 rounded-xl pointer-events-auto z-30"
            style={{
              left: `${selectionBounds.x}px`,
              top: `${selectionBounds.y}px`,
              width: `${selectionBounds.width}px`,
              height: `${selectionBounds.height}px`,
            }}
            onPointerDown={handleLassoMoveStart}
            onPointerMove={handleLassoMove}
            onPointerUp={handleLassoMoveEnd}
          >
            {/* Center Drag Cursor */}
            <div className="absolute inset-0 cursor-move" />

            {/* Scale Handle in Bottom-Right Corner */}
            <div
              onPointerDown={handleLassoScaleStart}
              onPointerMove={handleLassoScale}
              onPointerUp={handleLassoScaleEnd}
              className="absolute -bottom-2 -right-2 w-5 h-5 bg-blue-600 text-white rounded-full flex items-center justify-center cursor-nwse-resize shadow-md z-40 hover:scale-125 transition"
              title="Scale Selected Strokes"
            >
              <Maximize2 className="w-3 h-3" />
            </div>

            {/* Advanced PDEDraw / Notability Floating Toolbar */}
            <div
              className="absolute -top-12 left-1/2 -translate-x-1/2 flex items-center space-x-1.5 bg-gray-900/95 dark:bg-[#1C1C1E]/95 text-white px-3 py-1.5 rounded-full shadow-2xl text-xs font-semibold whitespace-nowrap z-40 backdrop-blur-md border border-white/10"
              onPointerDown={(e) => e.stopPropagation()}
            >
              {/* LaTeX Math Conversion (Notes2LaTeX) */}
              <button
                onClick={() => handleTriggerConvert('math')}
                className="flex items-center space-x-1 px-2.5 py-1 bg-blue-600 hover:bg-blue-500 rounded-full transition shadow-xs text-white"
                title="Convert handwriting to clean LaTeX formula"
              >
                <Sparkles className="w-3.5 h-3.5 text-yellow-300" />
                <span>LaTeX Math</span>
              </button>

              {/* TikZ Diagram Conversion */}
              <button
                onClick={() => handleTriggerConvert('tikz')}
                className="flex items-center space-x-1 px-2.5 py-1 bg-indigo-600 hover:bg-indigo-500 rounded-full transition shadow-xs text-white"
                title="Convert sketch to pure transparent TikZ vector diagram"
              >
                <Share2 className="w-3.5 h-3.5 text-green-300" />
                <span>TikZ Diagram</span>
              </button>

              <div className="w-[1px] h-4 bg-gray-700" />

              {/* Snap to Shape (PDEDraw Auto-Shape) */}
              <button
                onClick={handleSnapToShape}
                className="p-1 hover:text-blue-400 rounded"
                title="Snap to geometric shape (Line, Ellipse, Rectangle, Triangle)"
              >
                <Shapes className="w-3.5 h-3.5" />
              </button>

              {/* Color Palette Picker */}
              <div className="flex items-center space-x-1 px-1">
                {['#000000', '#3B82F6', '#EF4444', '#10B981', '#A855F7'].map(c => (
                  <button
                    key={c}
                    onClick={() => handleRecolorSelection(c)}
                    className="w-3.5 h-3.5 rounded-full border border-white/30 hover:scale-125 transition"
                    style={{ backgroundColor: c }}
                    title={`Recolor: ${c}`}
                  />
                ))}
              </div>

              {/* Line Style Toggles */}
              <button
                onClick={() => handleToggleLineStyle('dashed')}
                className="px-1.5 py-0.5 text-[10px] text-gray-300 hover:text-white border border-gray-700 rounded"
                title="Convert to Dashed line"
              >
                ---
              </button>
              <button
                onClick={() => handleToggleLineStyle('dotted')}
                className="px-1.5 py-0.5 text-[10px] text-gray-300 hover:text-white border border-gray-700 rounded"
                title="Convert to Dotted line"
              >
                ···
              </button>

              <div className="w-[1px] h-4 bg-gray-700" />

              {/* Duplicate */}
              <button
                onClick={handleDuplicateSelection}
                className="p-1 hover:text-blue-400 rounded"
                title="Duplicate Selection"
              >
                <Copy className="w-3.5 h-3.5" />
              </button>

              {/* Delete */}
              <button
                onClick={handleDeleteSelection}
                className="p-1 hover:text-red-400 rounded"
                title="Delete Selection"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}

        {/* Page Footer */}
        <div className="absolute bottom-2 right-4 text-[11px] font-medium text-gray-400 select-none">
          Page {pageNumber}
        </div>
      </div>
    </div>
  );
};
