import Image from "next/image";
import { asset } from "@/lib/asset";

export function SelfEscalation({ className = "" }: { className?: string }) {
  return (
    <Image
      src={asset("/vignettes/self-escalation.png")}
      alt="At the ticket office, the courier robot on a stool reaches for the green stamp, but the operator holds it out of reach — the stamp is tagged operator only"
      width={1376}
      height={768}
      className={`h-auto rounded-md ${className}`}
    />
  );
}
