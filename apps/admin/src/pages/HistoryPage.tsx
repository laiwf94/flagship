import { History } from '../flags/History';
import { useScope } from './Layout';

export function HistoryPage() {
  const { project } = useScope();
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>History</h1>
          <p className="muted">
            Every change in {project.name}: who made it, when, and exactly what changed.
          </p>
        </div>
      </div>
      <History project={project.key} />
    </div>
  );
}
