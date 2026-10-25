import { Link } from 'react-router';
import { EmptyState } from '../components/ui';

export function NotFound() {
  return (
    <main id="main">
      <EmptyState
        icon="search"
        title="Page not found"
        action={<Link to="/">Go to your flags</Link>}
      >
        The link may be out of date, or the flag or project was renamed.
      </EmptyState>
    </main>
  );
}
