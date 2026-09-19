import { useMemo } from 'react';
import { encode } from 'uqr';

export function TotpQr({ value, label }: { value: string; label: string }) {
  const qr = useMemo(() => encode(value, { ecc: 'M', border: 4 }), [value]);
  const modulePx = 4;
  const px = qr.size * modulePx;
  const d = useMemo(() => {
    const parts: string[] = [];
    qr.data.forEach((row, y) => {
      row.forEach((on, x) => {
        if (on) parts.push(`M${x * modulePx},${y * modulePx}h${modulePx}v${modulePx}h-${modulePx}z`);
      });
    });
    return parts.join('');
  }, [qr]);

  return (
    <div className="rounded-lg bg-white p-2">
      <svg
        role="img"
        aria-label={label}
        width={px}
        height={px}
        viewBox={`0 0 ${px} ${px}`}
        className="block text-black"
        shapeRendering="crispEdges"
      >
        <rect width={px} height={px} fill="white" />
        <path d={d} fill="black" />
      </svg>
    </div>
  );
}
