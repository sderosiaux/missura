import Image from "next/image";

export function PassExpires({ className = "" }: { className?: string }) {
  return (
    <Image
      src="/vignettes/pass-expires.png"
      alt="The courier robot waves goodbye at the exit while the ink on its day pass fades and the clock reads zero"
      width={1408}
      height={768}
      className={`h-auto rounded-md ${className}`}
    />
  );
}
