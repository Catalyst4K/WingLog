/** Navigraph's four-point compass-star mark, as a plain inline SVG — same "just a
 *  component" pattern as the lucide-react icons used everywhere else, since this one
 *  isn't in that set. Colors are fixed (not theme-tokenized) to match the real mark. */
export function NavigraphLogo(props: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 100 100" className={props.className} aria-hidden="true">
      <path d="M50 50 L50 10 L28 34 Z" fill="#e8543f" />
      <path d="M50 50 L50 10 L72 34 Z" fill="#a5312a" />
      <path d="M50 50 L90 50 L72 34 Z" fill="#dadfe3" />
      <path d="M50 50 L90 50 L72 66 Z" fill="#9aa1a8" />
      <path d="M50 50 L50 90 L72 66 Z" fill="#dadfe3" />
      <path d="M50 50 L50 90 L28 66 Z" fill="#9aa1a8" />
      <path d="M50 50 L10 50 L28 66 Z" fill="#dadfe3" />
      <path d="M50 50 L10 50 L28 34 Z" fill="#9aa1a8" />
    </svg>
  )
}
