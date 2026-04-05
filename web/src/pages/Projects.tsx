import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type Project } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Plus, ExternalLink, MessageSquare, Layers, Activity } from 'lucide-react';
import { cn } from '@/lib/utils';

const STATUS_STYLES: Record<Project['workspace_status'], string> = {
  created: 'bg-muted text-muted-foreground',
  running: 'bg-emerald-500/10 text-emerald-400',
  paused: 'bg-amber-500/10 text-amber-400',
  destroyed: 'bg-red-500/10 text-red-400',
};

function formatDate(dateStr: string | null): string {
  if (!dateStr) return 'Never';
  const d = new Date(dateStr);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function Projects() {
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState({ name: '', description: '' });
  const [formError, setFormError] = useState<string | null>(null);

  const { data: projects = [], isLoading } = useQuery({
    queryKey: ['projects'],
    queryFn: api.getProjects,
  });

  const createMutation = useMutation({
    mutationFn: (data: { name: string; description?: string }) => api.createProject(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      setDialogOpen(false);
      setForm({ name: '', description: '' });
      setFormError(null);
    },
    onError: (err: Error) => {
      setFormError(err.message);
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) {
      setFormError('Name is required.');
      return;
    }
    setFormError(null);
    createMutation.mutate({
      name: form.name.trim(),
      description: form.description.trim() || undefined,
    });
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Activity className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Layers className="h-5 w-5" />
            Projects
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            AI-managed application projects with version-controlled sessions
          </p>
        </div>
        <Button size="sm" onClick={() => setDialogOpen(true)}>
          <Plus className="h-4 w-4 mr-1.5" />
          New Project
        </Button>
      </div>

      {projects.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-6 py-12 text-center">
          <Layers className="h-8 w-8 mx-auto text-muted-foreground mb-3" />
          <p className="text-sm font-medium mb-1">No projects yet</p>
          <p className="text-xs text-muted-foreground mb-4">
            Create a project to let agents build and deploy applications.
          </p>
          <Button size="sm" onClick={() => setDialogOpen(true)}>
            <Plus className="h-4 w-4 mr-1.5" />
            New Project
          </Button>
        </div>
      ) : (
        <div className="grid gap-3">
          {projects.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) { setForm({ name: '', description: '' }); setFormError(null); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New Project</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4 mt-2">
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="proj-name">
                Name <span className="text-destructive">*</span>
              </label>
              <Input
                id="proj-name"
                placeholder="My App"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="proj-desc">
                Description <span className="text-muted-foreground text-xs">(optional)</span>
              </label>
              <Textarea
                id="proj-desc"
                placeholder="What does this project do?"
                rows={3}
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              />
            </div>
            {formError && (
              <p className="text-sm text-destructive">{formError}</p>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => { setDialogOpen(false); setForm({ name: '', description: '' }); setFormError(null); }}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={createMutation.isPending}>
                {createMutation.isPending ? 'Creating...' : 'Create'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ProjectCard({ project }: { project: Project }) {
  return (
    <Card className="hover:bg-muted/20 transition-colors">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="text-base font-medium">{project.name}</CardTitle>
            {project.description && (
              <p className="text-xs text-muted-foreground mt-0.5 truncate">{project.description}</p>
            )}
          </div>
          <Badge
            variant="outline"
            className={cn('shrink-0 text-[10px] capitalize', STATUS_STYLES[project.workspace_status])}
          >
            {project.workspace_status}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-4 text-xs text-muted-foreground mb-3">
          <span>{project.session_count} session{project.session_count !== 1 ? 's' : ''}</span>
          <span>Last session: {formatDate(project.last_session_at)}</span>
          {project.last_commit_sha && (
            <span className="font-mono">{project.last_commit_sha.slice(0, 7)}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {project.app_url && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              asChild
            >
              <a href={project.app_url} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-3 w-3 mr-1.5" />
                Open App
              </a>
            </Button>
          )}
          <Button
            variant="default"
            size="sm"
            className="h-7 text-xs"
            onClick={() => { window.location.hash = `#/projects/${project.id}`; }}
          >
            <MessageSquare className="h-3 w-3 mr-1.5" />
            Chat
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
