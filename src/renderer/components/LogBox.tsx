import React, { useEffect, useRef } from 'react';

interface Props {
  lines: string[];
}

const FOLLOW_THRESHOLD = 50;

export const LogBox: React.FC<Props> = ({ lines }) => {
  const ref = useRef<HTMLDivElement | null>(null);
  const followRef = useRef<boolean>(true);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (followRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [lines]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    followRef.current = distance < FOLLOW_THRESHOLD;
  };

  return (
    <div className="logbox" ref={ref} onScroll={onScroll}>
      {lines.length === 0 ? '日志输出 …' : lines.join('\n')}
    </div>
  );
};
