import { Navigate } from 'react-router';
import { api } from '../api';
import { EmptyState, ErrorState, Loading } from '../components/ui';
import { useResource } from '../hooks';

/** Sends people to the first project's production environment (or its first one). */
export function Home() {
  const projects = useResource(() => api.projects(), 'projects');
  if (projects.error !== undefined) {
    return (
      <main id="main">
        <ErrorState message={projects.error.message} onRetry={projects.reload} />
      </main>
    );
  }
  if (projects.data === undefined) return <Loading rows={3} label="Loading projects" />;
  const first = projects.data.projects[0];
  const env = first?.environments.find((e) => e.key === 'production') ?? first?.environments[0];
  if (first === undefined || env === undefined) {
    return (
      <main id="main">
        <EmptyState icon="flag" title="No projects yet">
          An admin creates the first project with POST /api/projects. A fresh install comes with
          one.
        </EmptyState>
      </main>
    );
  }
  return <Navigate to={`/p/${first.key}/${env.key}/flags`} replace />;
}
