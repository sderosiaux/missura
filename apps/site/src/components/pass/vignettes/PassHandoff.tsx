import Image from "next/image";
import { asset } from "@/lib/asset";

export function PassHandoff({ className = "" }: { className?: string }) {
  return (
    <Image
      src={asset("/vignettes/pass-handoff.png")}
      alt="A human operator behind a counter stamps a day pass and hands it to the courier robot; the giant keyring stays locked in a cabinet behind the counter"
      width={1408}
      height={768}
      className={`h-auto rounded-md ${className}`}
    />
  );
}
