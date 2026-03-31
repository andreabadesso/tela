import { useState } from 'react';
import { ChevronDown, ChevronRight, Wrench } from 'lucide-react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

interface ToolCallProps {
  name: string;
  args?: unknown;
  result?: unknown;
}

export function ToolCallCard({ name, args, result }: ToolCallProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <Card className="my-2 border-border/50 bg-muted/30">
      <CardHeader
        className="flex cursor-pointer flex-row items-center gap-2 px-3 py-2"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
        )}
        <Wrench className="h-3.5 w-3.5 text-muted-foreground" />
        <Badge variant="secondary" className="text-xs font-mono">
          {name}
        </Badge>
      </CardHeader>
      {expanded && (
        <CardContent className="space-y-2 px-3 pb-3 pt-0">
          {args !== undefined && (
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">Arguments</p>
              <pre className="overflow-x-auto rounded-md bg-muted/50 p-2 text-xs">
                {JSON.stringify(args, null, 2)}
              </pre>
            </div>
          )}
          {result !== undefined && (
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">Result</p>
              <pre className="overflow-x-auto rounded-md bg-muted/50 p-2 text-xs">
                {typeof result === 'string' ? result : JSON.stringify(result, null, 2)}
              </pre>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}
