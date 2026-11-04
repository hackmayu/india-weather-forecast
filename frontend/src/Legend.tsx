import { classLabel, type Scale } from "./colors";

export default function Legend({ scale, title, note }: { scale: Scale; title: string; note?: string }) {
  if (scale.type === "classes") {
    return (
      <figure className="legend" aria-label={title}>
        <figcaption>{title}</figcaption>
        <ul className="classbar">
          {scale.thresholds.map((th, i) => (
            <li key={i} title={`${classLabel(i, scale.thresholds)} ${scale.unit}`}>
              <span className="swatch" style={{ background: scale.colors[i] }} aria-hidden="true" />
              <span className="tick" aria-hidden="true">{th}</span>
              <span className="sr-only">{classLabel(i, scale.thresholds)} {scale.unit}</span>
            </li>
          ))}
        </ul>
        <p className="legend-note">Each colour starts at the number below it; below {scale.thresholds[0]} {scale.unit} nothing is coloured.</p>
        {note && <p className="legend-note">{note}</p>}
      </figure>
    );
  }
  const lo = scale.stops[0].v, hi = scale.stops[scale.stops.length - 1].v;
  const grad = scale.stops.map((s) => {
    const hex = s.color.slice(1);
    const a = s.alpha ?? 1;
    const rgba = `rgba(${parseInt(hex.slice(0, 2), 16)},${parseInt(hex.slice(2, 4), 16)},${parseInt(hex.slice(4, 6), 16)},${a})`;
    return `${rgba} ${((s.v - lo) / (hi - lo)) * 100}%`;
  }).join(", ");
  return (
    <figure className="legend" aria-label={title}>
      <figcaption>{title}</figcaption>
      <div className="ramp" style={{ background: `linear-gradient(to right, ${grad})` }} role="img" aria-label={`Colour ramp from ${lo} to ${hi} ${scale.unit}`} />
      <div className="ramp-ticks" aria-hidden="true">
        {scale.stops.map((s) => <span key={s.v}>{s.v}</span>)}
      </div>
      {note && <p className="legend-note">{note}</p>}
    </figure>
  );
}
