/**
 * A picture that shows a soft pulsing block until it has loaded. The block is the frame's own background and the picture
 * sits on top of it, so there is no script and nothing to go wrong on a cached image. `className` sets the frame's size,
 * corners and border; the picture fills it. If the picture fails, its alt text shows on the block.
 */
export function PhotoFrame({
  src,
  alt,
  className = "",
  priority = false,
}: {
  src: string;
  alt: string;
  className?: string;
  priority?: boolean;
}) {
  return (
    <span className={`block animate-pulse overflow-hidden bg-line motion-reduce:animate-none ${className}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        loading={priority ? "eager" : "lazy"}
        decoding="async"
        className="block h-full w-full object-cover text-xs text-muted"
      />
    </span>
  );
}
