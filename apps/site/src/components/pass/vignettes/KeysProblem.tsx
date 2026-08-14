import Image from "next/image";

export function KeysProblem({ className = "" }: { className?: string }) {
  return (
    <Image
      src="/vignettes/keys-problem.png"
      alt="The Missura courier robot buckling under a giant keyring of oversized keys tagged admin, all customers, and asterisk"
      width={1376}
      height={768}
      className={`h-auto rounded-md ${className}`}
    />
  );
}
