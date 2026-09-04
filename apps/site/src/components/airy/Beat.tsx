import Image from "next/image";

import { asset } from "@/lib/asset";

/**
 * One square engraving with its line underneath. The caption sits below the
 * plate rather than over it: these are cream, finely hatched drawings, and a
 * scrim heavy enough to carry white text would erase the hatching that makes
 * them worth showing.
 */
export function Beat({
  image,
  alt,
  title,
  mark,
}: {
  image: string;
  alt: string;
  title: string;
  mark: string;
}) {
  return (
    <div className="w-[78vw] max-w-[420px] sm:w-[52vw] lg:w-[400px]">
      <div className="ac-card">
        <Image
          src={asset(`/vignettes/${image}`)}
          alt={alt}
          width={1024}
          height={1024}
          className="aspect-square object-cover"
        />
      </div>
      <div className="mt-5 flex items-start justify-between gap-4">
        <h3 className="ac-h3 max-w-[12ch]">{title}</h3>
        <span className="mt-2 flex-none font-mono text-[0.72rem] tracking-[0.08em] text-ink-soft uppercase">
          {mark}
        </span>
      </div>
    </div>
  );
}
