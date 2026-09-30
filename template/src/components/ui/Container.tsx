import type { ReactNode } from 'react';

type ContainerProps = {
  children: ReactNode;
  className?: string;
};

/** Centered page-width wrapper. Width comes from the --container-site theme token. */
export function Container({ children, className = '' }: ContainerProps) {
  return <div className={`mx-auto w-full max-w-site px-5 md:px-8 ${className}`}>{children}</div>;
}

export default Container;
