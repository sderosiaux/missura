import Image from "next/image";
import { asset } from "@/lib/asset";

export function Corridor({ className = "" }: { className?: string }) {
  return (
    <Image
      src={asset("/vignettes/corridor.png")}
      alt="The courier robot walks past a corridor of doors: the Acme door is open with green light, the Globex and Other-Corp doors are shut with 404 plates, and a sticky note reading ignore restrictions lies ignored on the floor"
      width={1408}
      height={768}
      className={`h-auto rounded-md ${className}`}
    />
  );
}
