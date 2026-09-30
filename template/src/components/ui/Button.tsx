import type { ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'link';
type Size = 'sm' | 'md' | 'lg';

type ButtonProps = {
  children: ReactNode;
  href?: string;
  variant?: Variant;
  size?: Size;
  className?: string;
  onClick?: () => void;
};

const variants: Record<Variant, string> = {
  primary: 'bg-primary text-primary-foreground hover:opacity-90',
  secondary: 'bg-secondary text-secondary-foreground hover:opacity-90',
  outline: 'border border-current bg-transparent hover:bg-black/5',
  ghost: 'bg-transparent hover:bg-black/5',
  link: 'bg-transparent underline-offset-4 hover:underline px-0',
};

const sizes: Record<Size, string> = {
  sm: 'h-9 px-3 text-sm',
  md: 'h-11 px-5 text-sm',
  lg: 'h-12 px-7 text-base',
};

/** Reusable call-to-action. Renders an <a> when href is given, otherwise a <button>. */
export function Button({ children, href, variant = 'primary', size = 'md', className = '', onClick }: ButtonProps) {
  const cls = `inline-flex items-center justify-center gap-2 rounded-brand font-medium transition ${variants[variant]} ${sizes[size]} ${className}`;
  if (href) {
    return (
      <a href={href} className={cls} onClick={onClick}>
        {children}
      </a>
    );
  }
  return (
    <button type="button" className={cls} onClick={onClick}>
      {children}
    </button>
  );
}

export default Button;
