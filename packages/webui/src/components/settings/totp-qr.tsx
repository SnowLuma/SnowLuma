import { useMemo } from 'react';
import { encode } from 'uqr';

export function TotpQr({ value, label }: { value: string; label: string }) {
  const qr = useMemo(() => encode(value, { ecc: 'M', border: 2 }), [value]);
  const modules = qr.data.flatMap((row, y) => (
    row.flatMap((on, x) => (
      on ? <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" /> : []
    ))
  ));

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${qr.size} ${qr.size}`}
      className="size-44 rounded-lg bg-white text-black"
      shapeRendering="crispEdges"
    >
      <rect width={qr.size} height={qr.size} fill="white" />
      <g fill="black">{modules}</g>
    </svg>
  );
}
