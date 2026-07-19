// TODO: Add i18n to this component

import React, { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { List } from 'react-window';
import { Loader2, Star as StarIcon, ZoomIn, ZoomOut, Maximize, Link, SquarePen } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import clsx from 'clsx';
import { Invokes, ImageFile } from '../../ui/AppProperties';
import { Thumbnail } from './LibraryItems';
import Text from '../../ui/Text';
import { TextColors, TextVariants, TextWeights } from '../../../types/typography';
import { useProcessStore } from '../../../store/useProcessStore';

interface SyncViewport {
  isActive: boolean;
  zoom: number;
  pan: { x: number; y: number };
  isDragging: boolean;
}

function CullingPreview({
  image,
  rating,
  isActive,
  isSelected,
  isFullWidth,
  syncViewport,
  setSyncViewport,
  onContextMenu,
  onImageDoubleClick,
}: {
  image: ImageFile;
  rating: number;
  isActive: boolean;
  isSelected: boolean;
  isFullWidth?: boolean;
  syncViewport: SyncViewport;
  setSyncViewport: React.Dispatch<React.SetStateAction<SyncViewport>>;
  onContextMenu: (e: React.MouseEvent, path: string, forceSingleSelection?: boolean) => void;
  onImageDoubleClick: (path: string) => void;
}) {
  const thumbUrl = useProcessStore((s) => s.thumbnails[image.path]);
  const initialPreview = useProcessStore((s) => s.previews[image.path]);
  const setPreview = useProcessStore((s) => s.setPreview);
  const safeThumbKey = thumbUrl || '';
  const [highResSrc, setHighResSrc] = useState<string | null>(
    initialPreview?.thumbKey === safeThumbKey ? initialPreview.url : null,
  );
  const [isLoading, setIsLoading] = useState(!highResSrc);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragStartMouse = useRef({ x: 0, y: 0 });
  const dragStartPan = useRef({ x: 0, y: 0 });
  const hasDragged = useRef(false);
  const zoomRef = useRef(zoom);
  const panRef = useRef(pan);

  useEffect(() => {
    zoomRef.current = zoom;
    panRef.current = pan;
  }, [zoom, pan]);

  const fullFileName = image.path.split(/[\\/]/).pop() || '';
  const parts = fullFileName.split('?vc=');
  const baseName = parts[0];
  const isVirtualCopy = parts.length > 1;

  useEffect(() => {
    const currentPreview = useProcessStore.getState().previews[image.path];
    if (currentPreview && currentPreview.thumbKey === safeThumbKey) {
      setHighResSrc(currentPreview.url);
      setIsLoading(false);
      setPreview(image.path, currentPreview.url, safeThumbKey);
      return;
    }

    let active = true;
    setIsLoading(true);
    setHighResSrc(null);

    const fetchPreviewWithAdjustments = async () => {
      try {
        const metadata: any = await invoke(Invokes.LoadMetadata, { path: image.path });
        if (!active) return;

        const adjustments =
          metadata && metadata.adjustments && !metadata.adjustments.is_null ? metadata.adjustments : {};

        const bytes = await invoke<Uint8Array>(Invokes.GeneratePreviewForPath, {
          path: image.path,
          jsAdjustments: adjustments,
        });
        if (!active) return;

        const blob = new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' });
        const localBlobUrl = URL.createObjectURL(blob);

        setPreview(image.path, localBlobUrl, safeThumbKey);

        if (active) {
          setHighResSrc(localBlobUrl);
          setIsLoading(false);
        }
      } catch (err) {
        console.error('Error loading culling preview with adjustments:', err);

        if (active) {
          try {
            const fallbackBytes = await invoke<Uint8Array>(Invokes.GeneratePreviewForPath, {
              path: image.path,
              jsAdjustments: {},
            });
            if (!active) return;
            const blob = new Blob([new Uint8Array(fallbackBytes)], { type: 'image/jpeg' });
            const localBlobUrl = URL.createObjectURL(blob);

            setPreview(image.path, localBlobUrl, safeThumbKey);
            setHighResSrc(localBlobUrl);
          } catch (fallbackErr) {
            console.error('Fallback preview generation also failed:', fallbackErr);
          }
          setIsLoading(false);
        }
      }
    };

    fetchPreviewWithAdjustments();

    return () => {
      active = false;
    };
  }, [image.path, safeThumbKey, setPreview]);

  useEffect(() => {
    if (syncViewport.isActive) {
      setZoom(syncViewport.zoom);
      setPan(syncViewport.pan);
    }
  }, [syncViewport.isActive, syncViewport.zoom, syncViewport.pan]);

  const updateViewport = (newZoom: number, newPan: { x: number; y: number }) => {
    setZoom(newZoom);
    setPan(newPan);
    if (syncViewport.isActive) {
      setSyncViewport((prev) => ({ ...prev, isActive: true, zoom: newZoom, pan: newPan }));
    }
  };

  useEffect(() => {
    if (!isDragging) return;
    const handleWindowMouseMove = (e: MouseEvent) => {
      const dx = e.clientX - dragStartMouse.current.x;
      const dy = e.clientY - dragStartMouse.current.y;

      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
        hasDragged.current = true;
      }

      const newPan = {
        x: dragStartPan.current.x + dx,
        y: dragStartPan.current.y + dy,
      };

      updateViewport(zoomRef.current, newPan);
    };

    const handleWindowMouseUp = () => {
      setIsDragging(false);
      setSyncViewport((prev) => (prev.isActive ? { ...prev, isDragging: false } : prev));
    };

    window.addEventListener('mousemove', handleWindowMouseMove);
    window.addEventListener('mouseup', handleWindowMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleWindowMouseMove);
      window.removeEventListener('mouseup', handleWindowMouseUp);
    };
  }, [isDragging, setSyncViewport]);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    setIsDragging(true);
    hasDragged.current = false;
    dragStartMouse.current = { x: e.clientX, y: e.clientY };
    dragStartPan.current = { x: panRef.current.x, y: panRef.current.y };
    setSyncViewport((prev) => (prev.isActive ? { ...prev, isDragging: true } : prev));
  };

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (hasDragged.current) return;

    if (zoom !== 1 || pan.x !== 0 || pan.y !== 0) {
      updateViewport(1, { x: 0, y: 0 });
    } else {
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        const mouseX = e.clientX - rect.left - rect.width / 2;
        const mouseY = e.clientY - rect.top - rect.height / 2;
        updateViewport(2, { x: -mouseX, y: -mouseY });
      } else {
        updateViewport(2, { x: 0, y: 0 });
      }
    }
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.stopPropagation();
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const mouseX = e.clientX - rect.left - rect.width / 2;
    const mouseY = e.clientY - rect.top - rect.height / 2;

    const zoomFactor = Math.exp(-e.deltaY * 0.002);
    const newZoom = Math.min(Math.max(0.1, zoom * zoomFactor), 8);
    const scaleRatio = newZoom / zoom;

    const mouseFromCenterX = mouseX - pan.x;
    const mouseFromCenterY = mouseY - pan.y;
    const newPanX = mouseX - mouseFromCenterX * scaleRatio;
    const newPanY = mouseY - mouseFromCenterY * scaleRatio;

    updateViewport(newZoom, { x: newPanX, y: newPanY });
  };

  const handleZoomIn = (e: React.MouseEvent) => {
    e.stopPropagation();
    const newZoom = Math.min(8, zoom * 1.25);
    const ratio = newZoom / zoom;
    updateViewport(newZoom, { x: pan.x * ratio, y: pan.y * ratio });
  };

  const handleZoomOut = (e: React.MouseEvent) => {
    e.stopPropagation();
    const newZoom = Math.max(0.1, zoom / 1.25);
    const ratio = newZoom / zoom;
    updateViewport(newZoom, { x: pan.x * ratio, y: pan.y * ratio });
  };

  const handleResetZoom = (e: React.MouseEvent) => {
    e.stopPropagation();
    updateViewport(1, { x: 0, y: 0 });
  };

  const toggleSync = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (syncViewport.isActive) {
      setSyncViewport((prev) => ({ ...prev, isActive: false }));
    } else {
      setSyncViewport({ isActive: true, zoom, pan, isDragging: false });
    }
  };

  const ringClass = isActive
    ? 'ring-2 ring-inset ring-accent'
    : isSelected
      ? 'ring-2 ring-inset ring-gray-400'
      : 'group-hover:ring-2 group-hover:ring-inset group-hover:ring-hover-color';

  const effectiveDragging = isDragging || (syncViewport.isActive && syncViewport.isDragging);
  const imageTransformStyle = {
    transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})`,
    transition: effectiveDragging ? 'none' : 'transform 0.1s ease-out',
    transformOrigin: 'center center',
    backfaceVisibility: 'hidden' as const,
  };

  return (
    <div
      ref={containerRef}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu(e, image.path, true);
      }}
      onClick={handleClick}
      onWheel={handleWheel}
      onMouseDown={handleMouseDown}
      className={clsx(
        'relative flex items-center justify-center w-full h-full overflow-hidden group bg-[#0f0f0f] rounded-lg shadow-sm border border-border-color/10 cursor-grab active:cursor-grabbing select-none',
        isFullWidth && 'col-span-2',
      )}
    >
      <div
        className="absolute inset-0 opacity-20 pointer-events-none z-0"
        style={{
          backgroundImage: 'radial-gradient(#444 1px, transparent 1px)',
          backgroundSize: '24px 24px',
        }}
      />

      <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
        <div className="origin-center w-full h-full flex items-center justify-center" style={imageTransformStyle}>
          {thumbUrl && (
            <img
              src={thumbUrl}
              className="absolute w-full h-full object-contain drop-shadow-lg"
              alt="Thumbnail Loading"
              draggable={false}
            />
          )}

          {highResSrc && (
            <motion.img
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.3 }}
              src={highResSrc}
              className="absolute w-full h-full object-contain drop-shadow-lg"
              alt="Culling Preview High Res"
              draggable={false}
            />
          )}
        </div>
      </div>

      <div
        className="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-black/70 backdrop-blur-md px-3 py-1.5 rounded-full border border-white/10 shadow-xl z-20 pointer-events-auto opacity-0 group-hover:opacity-100 transition-opacity duration-200"
        onMouseDown={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
      >
        <AnimatePresence>
          {isLoading && (
            <motion.div
              initial={{ opacity: 0, width: 0 }}
              animate={{ opacity: 1, width: 'auto' }}
              exit={{ opacity: 0, width: 0 }}
              className="flex items-center justify-center overflow-hidden"
            >
              <Loader2 className="w-4 h-4 animate-spin text-white mr-1" />
            </motion.div>
          )}
        </AnimatePresence>

        <Text variant={TextVariants.small} className="text-white truncate max-w-37.5">
          {baseName}
        </Text>

        {(isVirtualCopy || rating > 0) && (
          <div className="flex items-center gap-1 shrink-0 ml-1">
            {isVirtualCopy && (
              <div className="bg-white/20 text-white px-1.5 py-0.5 rounded-sm">
                <Text variant={TextVariants.small} weight={TextWeights.bold} className="text-[9px] leading-none">
                  VC
                </Text>
              </div>
            )}
            {rating > 0 && (
              <div className="flex items-center gap-1 bg-white/20 px-1.5 py-0.5 rounded-sm">
                <Text variant={TextVariants.small} className="text-white font-medium leading-none text-[10px]">
                  {rating}
                </Text>
                <StarIcon size={10} className="text-accent fill-accent" />
              </div>
            )}
          </div>
        )}

        <div className="w-px h-5 bg-white/20 mx-1 shrink-0"></div>

        <button
          onClick={(e) => {
            e.stopPropagation();
            onImageDoubleClick(image.path);
          }}
          className="p-1.5 text-white/60 hover:bg-white/10 hover:text-white rounded-full transition-colors shrink-0"
          data-tooltip="Edit Image"
        >
          <SquarePen size={14} />
        </button>

        <div className="w-px h-5 bg-white/20 mx-1 shrink-0"></div>

        <button
          onClick={toggleSync}
          className={clsx(
            'p-1.5 rounded-full transition-colors shrink-0',
            syncViewport.isActive ? 'bg-accent text-button-text' : 'text-white/60 hover:bg-white/10 hover:text-white',
          )}
          data-tooltip="Sync Zoom and Pan"
        >
          <Link size={14} />
        </button>

        <button
          onClick={handleZoomOut}
          className="p-1.5 text-white/60 hover:bg-white/10 hover:text-white rounded-full transition-colors shrink-0"
        >
          <ZoomOut size={16} />
        </button>

        <span className="text-xs font-mono text-white/90 w-10 text-center select-none pointer-events-none shrink-0">
          {Math.round(zoom * 100)}%
        </span>

        <button
          onClick={handleZoomIn}
          className="p-1.5 text-white/60 hover:bg-white/10 hover:text-white rounded-full transition-colors shrink-0"
        >
          <ZoomIn size={16} />
        </button>

        <button
          onClick={handleResetZoom}
          className="p-1.5 text-white/60 hover:bg-white/10 hover:text-white rounded-full transition-colors shrink-0"
        >
          <Maximize size={14} />
        </button>
      </div>

      <div
        className={clsx(
          'absolute inset-0 rounded-lg pointer-events-none z-30 transition-all duration-150 ring-2 ring-inset ring-transparent',
          ringClass,
        )}
      />
    </div>
  );
}

const Row = React.memo(
  ({
    index,
    style,
    imageList,
    multiSelectedPaths,
    activePath,
    onContextMenu,
    onImageDoubleClick,
    thumbnailAspectRatio,
    imageRatings,
    handleSidebarClick,
    queueThumbnailRequest,
  }: any) => {
    const image: ImageFile = imageList[index];
    const isSelected = multiSelectedPaths.includes(image.path);

    useEffect(() => {
      if (!image || !queueThumbnailRequest) return;
      queueThumbnailRequest(image.path);

      if (image.is_cloud_placeholder) {
        const interval = setInterval(() => {
          queueThumbnailRequest(image.path);
        }, 5000);
        return () => clearInterval(interval);
      }
    }, [image, queueThumbnailRequest]);

    return (
      <div style={style} className="p-2 box-border">
        <div className="w-full h-full">
          <Thumbnail
            path={image.path}
            isSelected={isSelected}
            isActive={activePath === image.path}
            onImageClick={(path: string, e: any) => handleSidebarClick(path, e)}
            onContextMenu={onContextMenu}
            onImageDoubleClick={onImageDoubleClick}
            onLoad={() => {}}
            rating={imageRatings?.[image.path] || 0}
            tags={image.tags}
            exif={image.exif}
            aspectRatio={thumbnailAspectRatio}
            isCloudPlaceholder={image.is_cloud_placeholder}
          />
        </div>
      </div>
    );
  },
);

export default function CullingView(props: any) {
  const {
    imageList,
    multiSelectedPaths,
    activePath,
    onImageClick,
    imageRatings,
    thumbnailAspectRatio,
    onContextMenu,
    onImageDoubleClick,
    onRequestThumbnails,
  } = props;

  const containerRef = useRef<HTMLDivElement>(null);
  const [listHeight, setListHeight] = useState(0);
  const [sidebarWidth, setSidebarWidth] = useState(224);
  const isResizing = useRef(false);

  const requestQueueRef = useRef<Set<string>>(new Set());
  const requestTimeoutRef = useRef<any>(null);

  const [syncViewport, setSyncViewport] = useState<SyncViewport>({
    isActive: false,
    zoom: 1,
    pan: { x: 0, y: 0 },
    isDragging: false,
  });

  const queueThumbnailRequest = useCallback(
    (path: string) => {
      if (!onRequestThumbnails) return;
      if (useProcessStore.getState().thumbnails[path]) return;
      requestQueueRef.current.add(path);
      if (!requestTimeoutRef.current) {
        requestTimeoutRef.current = setTimeout(() => {
          const paths = Array.from(requestQueueRef.current);
          if (paths.length > 0) {
            onRequestThumbnails(paths);
            requestQueueRef.current.clear();
          }
          requestTimeoutRef.current = null;
        }, 50);
      }
    },
    [onRequestThumbnails],
  );

  useEffect(() => {
    const updateHeight = () => {
      if (containerRef.current) {
        setListHeight(containerRef.current.clientHeight);
      }
    };
    updateHeight();
    window.addEventListener('resize', updateHeight);
    return () => window.removeEventListener('resize', updateHeight);
  }, []);

  const resize = useCallback((mouseMoveEvent: MouseEvent) => {
    if (!isResizing.current) return;
    const newWidth = window.innerWidth - mouseMoveEvent.clientX;
    if (newWidth >= 160 && newWidth <= 450) {
      setSidebarWidth(newWidth);
    }
  }, []);

  const stopResizing = useCallback(() => {
    isResizing.current = false;
    document.removeEventListener('mousemove', resize);
    document.removeEventListener('mouseup', stopResizing);
  }, [resize]);

  const startResizing = useCallback(
    (mouseDownEvent: React.MouseEvent) => {
      mouseDownEvent.preventDefault();
      isResizing.current = true;
      document.addEventListener('mousemove', resize);
      document.addEventListener('mouseup', stopResizing);
    },
    [resize, stopResizing],
  );

  useEffect(() => {
    return () => {
      document.removeEventListener('mousemove', resize);
      document.removeEventListener('mouseup', stopResizing);
    };
  }, [resize, stopResizing]);

  const handleSidebarClick = useCallback(
    (path: string, e: React.MouseEvent) => {
      onImageClick(path, { ...e, ctrlKey: true, metaKey: true });
    },
    [onImageClick],
  );

  const rowProps = useMemo(
    () => ({
      imageList,
      multiSelectedPaths,
      activePath,
      thumbnailAspectRatio,
      imageRatings,
      onContextMenu,
      onImageDoubleClick,
      handleSidebarClick,
      queueThumbnailRequest,
      sidebarWidth,
    }),
    [
      imageList,
      multiSelectedPaths,
      activePath,
      thumbnailAspectRatio,
      imageRatings,
      onContextMenu,
      onImageDoubleClick,
      handleSidebarClick,
      queueThumbnailRequest,
      sidebarWidth,
    ],
  );

  const displayPaths = multiSelectedPaths.slice(-4);
  const displayImages = displayPaths
    .map((p: string) => imageList.find((img: ImageFile) => img.path === p))
    .filter(Boolean);
  const displayCount = displayImages.length;

  return (
    <div className="flex w-full h-full min-h-0 bg-transparent">
      <div className="flex-1 flex overflow-hidden relative bg-transparent">
        {displayCount === 0 ? (
          <div className="m-auto text-center">
            <Text variant={TextVariants.heading} color={TextColors.secondary}>
              Select images to compare
            </Text>
            <Text className="mt-2 text-text-secondary">
              Click thumbnails in the right sidebar to add them to the comparison view.
            </Text>
          </div>
        ) : (
          <div
            className={clsx(
              'grid gap-4 w-full h-full p-4',
              displayCount === 1 && 'grid-cols-1 grid-rows-1',
              displayCount === 2 && 'grid-cols-2 grid-rows-1',
              displayCount === 3 && 'grid-cols-2 grid-rows-2',
              displayCount === 4 && 'grid-cols-2 grid-rows-2',
            )}
          >
            {displayImages.map((img: ImageFile, index: number) => (
              <CullingPreview
                key={img.path}
                image={img}
                rating={imageRatings?.[img.path] || 0}
                onContextMenu={onContextMenu}
                onImageDoubleClick={onImageDoubleClick}
                isActive={activePath === img.path}
                isSelected={true}
                isFullWidth={displayCount === 3 && index === 2}
                syncViewport={syncViewport}
                setSyncViewport={setSyncViewport}
              />
            ))}
          </div>
        )}
      </div>

      <div
        ref={containerRef}
        style={{ width: sidebarWidth }}
        className="relative shrink-0 border-l border-surface/50 bg-bg-secondary/50 flex flex-col"
      >
        <div
          onMouseDown={startResizing}
          className="absolute top-0 bottom-0 left-0 w-1 cursor-col-resize hover:bg-surface/50 active:bg-surface transition-colors z-40"
        />
        <div key={`${sidebarWidth}-${thumbnailAspectRatio}`} style={{ height: listHeight, width: '100%' }}>
          <List
            rowCount={imageList.length}
            rowHeight={sidebarWidth - 16}
            rowComponent={Row}
            rowProps={rowProps}
            className="custom-scrollbar"
          />
        </div>
      </div>
    </div>
  );
}
