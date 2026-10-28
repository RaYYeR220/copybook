import { constellations, LIMB, PLATE_OUT, roman } from "@/lib/atlas";
import { f1, rad } from "@/lib/motion";
import styles from "./Plate.module.css";

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const DEGREES = Array.from({ length: 180 }, (_, i) => i * 2);

/**
 * The engraved atlas plate: hour ring with roman numerals, degree ticks, the equinoctial and the ecliptic, and six
 * constellations. Pure markup in plate units (viewBox ±660); the nightfall scene scales and places it.
 */
export function Plate({ className }: { className?: string }) {
  return (
    <svg className={[styles.plate, className].filter(Boolean).join(" ")} viewBox={`${-PLATE_OUT} ${-PLATE_OUT} ${PLATE_OUT * 2} ${PLATE_OUT * 2}`} aria-hidden="true">
      {[140, 280].map((r) => (
        <circle key={r} r={r} className={`${styles.ring} ${styles.dec}`} />
      ))}
      <circle r="420" className={styles.ring} />
      <circle r="70" className={styles.ring} />
      <path id="atlas-eq" fill="none" d="M -420 0 A 420 420 0 1 1 420 0 A 420 420 0 1 1 -420 0" />
      <text className={styles.lat}>
        <textPath href="#atlas-eq" startOffset="6%">
          CIRCULUS AEQUINOCTIALIS
        </textPath>
      </text>

      {HOURS.map((i) => {
        const a = rad(i * 15);
        const c = Math.cos(a);
        const s = Math.sin(a);
        const b = rad(i * 15 + 7.5);
        const lr = LIMB + 51;
        const lx = f1(lr * Math.cos(b));
        const ly = f1(lr * Math.sin(b));
        return (
          <g key={i}>
            <line x1={f1(70 * c)} y1={f1(70 * s)} x2={f1(LIMB * c)} y2={f1(LIMB * s)} className={`${styles.hl} ${i % 6 === 0 ? styles.major : ""}`} />
            <text className={styles.rn} x={lx} y={ly} transform={`rotate(${f1(i * 15 + 97.5)} ${lx} ${ly})`}>
              {roman(i + 1)}
            </text>
            <line x1={f1((LIMB + 30) * c)} y1={f1((LIMB + 30) * s)} x2={f1((LIMB + 72) * c)} y2={f1((LIMB + 72) * s)} className={styles.tk} />
          </g>
        );
      })}

      <circle r={LIMB} className={`${styles.ring} ${styles.strong}`} />
      <circle r={LIMB + 30} className={`${styles.ring} ${styles.strong}`} />
      <circle r={LIMB + 72} className={styles.ring} />
      <circle r={LIMB + 77} className={`${styles.ring} ${styles.strong}`} />

      {DEGREES.map((d) => {
        const a = rad(d);
        const c = Math.cos(a);
        const s = Math.sin(a);
        const len = d % 30 === 0 ? 30 : d % 10 === 0 ? 14 : 6;
        return (
          <line
            key={d}
            x1={f1(LIMB * c)}
            y1={f1(LIMB * s)}
            x2={f1((LIMB + len) * c)}
            y2={f1((LIMB + len) * s)}
            className={`${styles.tk} ${d % 30 === 0 ? styles.big : ""}`}
          />
        );
      })}

      <path id="atlas-ecl" className={styles.ecl} d="M -468 118 A 468 468 0 1 1 468 118 A 468 468 0 1 1 -468 118" />
      <text className={styles.lat}>
        <textPath href="#atlas-ecl" startOffset="56%">
          ECLIPTICA
        </textPath>
      </text>

      {constellations.map((C) => (
        <g key={C.name}>
          {C.segments.map(([x1, y1, x2, y2], i) => (
            <line key={i} className={styles.cl} x1={f1(x1)} y1={f1(y1)} x2={f1(x2)} y2={f1(y2)} />
          ))}
          <text className={styles.cn} x={f1(C.label[0])} y={f1(C.label[1])} textAnchor="middle">
            {C.name}
          </text>
        </g>
      ))}
    </svg>
  );
}
