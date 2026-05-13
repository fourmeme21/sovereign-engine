interface Props {
  count: number;
}

export default function SilentSuccessDot({ count }: Props) {
  return (
    <div className="silent-dot" title={`${count} değişiklik otomatik onaylandı`}>
      <span className="dot-green" />
      <span className="dot-label">{count} geçti</span>
    </div>
  );
}
