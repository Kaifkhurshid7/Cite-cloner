import { Component, type ReactNode } from 'react';

type Props = { name: string; children: ReactNode };
type State = { error: Error | null };

/**
 * Isolates each generated section: a runtime error in one section is logged
 * (the agent's validator listens for "[section-error]") instead of blanking the page.
 */
export class SectionBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error(`[section-error] ${this.props.name}: ${error.message}`);
  }

  render() {
    if (this.state.error) return null;
    // display:contents keeps sticky/fixed children working (wrapper generates no box)
    return (
      <div data-section={this.props.name} style={{ display: "contents" }}>
        {this.props.children}
      </div>
    );
  }
}

export default SectionBoundary;
