import { useMemo } from "react";

interface QRCodeDisplayProps {
  value: string;
  size?: number;
  label?: string;
}

/**
 * A deterministic visual code badge for the emergency passport.
 *
 * IMPORTANT: this is NOT a scannable QR code. It draws the three finder
 * squares and the timing rows of the QR layout, then fills the data area from
 * a hash of `value`; there is no QR encoding, error correction or mask, so no
 * scanner can read it. It exists as a recognisable visual anchor for a
 * passport card. The verification token printed beneath it is the mechanism
 * that actually works, and it is what the verify screen accepts.
 *
 * Because only a 32-bit hash of `value` reaches the image, nothing in the
 * rendered pattern can be reversed into patient information.
 *
 * Replacing this with a real QR code means adding an encoder (for example the
 * `qrcode` package) and a decoder test proving the output scans.
 */
export function QRCodeDisplay({ value, size = 200, label }: QRCodeDisplayProps) {
  // Deterministic 25x25 matrix with QR-shaped finder patterns. See above:
  // the data cells are decorative.
  const matrix = useMemo(() => {
    const n = 25;
    const grid: boolean[][] = Array.from({ length: n }, () => Array(n).fill(false));

    // Place 7x7 Finder Pattern at (row, col)
    function placeFinder(r: number, c: number) {
      for (let i = 0; i < 7; i++) {
        for (let j = 0; j < 7; j++) {
          if (
            i === 0 ||
            i === 6 ||
            j === 0 ||
            j === 6 ||
            (i >= 2 && i <= 4 && j >= 2 && j <= 4)
          ) {
            grid[r + i][c + j] = true;
          }
        }
      }
    }

    placeFinder(0, 0); // Top-left
    placeFinder(0, n - 7); // Top-right
    placeFinder(n - 7, 0); // Bottom-left

    // Timing patterns
    for (let i = 8; i < n - 8; i++) {
      grid[6][i] = i % 2 === 0;
      grid[i][6] = i % 2 === 0;
    }

    // Hash-based data encoding
    let hash = 0;
    for (let i = 0; i < value.length; i++) {
      hash = (hash << 5) - hash + value.charCodeAt(i);
      hash |= 0;
    }

    let seed = Math.abs(hash) || 12345;
    function nextBit() {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % 2 === 0;
    }

    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const inFinderTL = r < 8 && c < 8;
        const inFinderTR = r < 8 && c >= n - 8;
        const inFinderBL = r >= n - 8 && c < 8;
        const isTiming = r === 6 || c === 6;
        if (!inFinderTL && !inFinderTR && !inFinderBL && !isTiming) {
          grid[r][c] = nextBit();
        }
      }
    }

    return grid;
  }, [value]);

  const n = matrix.length;
  const cellSize = size / n;

  return (
    <div className="flex flex-col items-center justify-center p-4 bg-white rounded-xl border border-slate-200 shadow-sm">
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="shape-rendering-crisp"
        role="img"
        aria-label={
          label
            ? `Decorative passport code badge for ${label}`
            : "Decorative passport code badge"
        }
      >
        <rect width={size} height={size} fill="#ffffff" />
        {matrix.map((row, r) =>
          row.map((cell, c) =>
            cell ? (
              <rect
                key={`${r}-${c}`}
                x={c * cellSize}
                y={r * cellSize}
                width={cellSize}
                height={cellSize}
                fill="#0f172a"
              />
            ) : null,
          ),
        )}
      </svg>
      {label && (
        <span className="mt-3 text-xs font-mono text-slate-500 text-center max-w-[220px] truncate">
          {label}
        </span>
      )}
      <span className="mt-2 text-[11px] text-amber-700 text-center max-w-[220px]">
        Visual badge only - not machine scannable. Verify using the token
        below.
      </span>
    </div>
  );
}

