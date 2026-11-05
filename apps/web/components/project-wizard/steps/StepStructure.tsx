import { ProjectData, WorkStructure } from "../types";
import { cn } from "@/lib/utils";

import { Label } from "../../ui/label";
import { Switch } from "../../ui/switch";
import { ArrowRight, Flag, GitMerge } from "@phosphor-icons/react/dist/ssr";

interface StepStructureProps {
  data: ProjectData;
  updateData: (updates: Partial<ProjectData>) => void;
}

export function StepStructure({ data, updateData }: StepStructureProps) {
    const structures: { id: WorkStructure; title: string; desc: string; icon: React.ReactNode; visual: React.ReactNode }[] = [
        {
            id: 'linear',
            title: 'Linear',
            desc: 'Sequential phases (e.g. Waterfall). One thing after another.',
            icon: <ArrowRight className="h-5 w-5" />,
            visual: (
                <div className="flex items-center gap-2 opacity-50">
                    <div className="h-2 w-8 rounded bg-current"></div>
                    <ArrowRight className="h-3 w-3" />
                    <div className="h-2 w-8 rounded bg-current"></div>
                    <ArrowRight className="h-3 w-3" />
                    <div className="h-2 w-8 rounded bg-current"></div>
                </div>
            )
        },
        {
            id: 'milestones',
            title: 'Milestones',
            desc: 'Key checkpoints or deadlines to hit along the way.',
            icon: <Flag className="h-5 w-5" />,
            visual: (
                <div className="flex items-center justify-between gap-1 opacity-50">
                    <div className="h-2 w-2 rounded-full bg-current"></div>
                    <div className="h-0.5 flex-1 bg-current"></div>
                    <Flag className="h-3 w-3" />
                    <div className="h-0.5 flex-1 bg-current"></div>
                    <div className="h-2 w-2 rounded-full bg-current"></div>
                </div>
            )
        },
        {
            id: 'multistream',
            title: 'Multi-stream',
            desc: 'Parallel tracks of work happening simultaneously.',
            icon: <GitMerge className="h-5 w-5" />,
            visual: (
                <div className="flex flex-col gap-1 opacity-50">
                    <div className="flex items-center gap-1">
                        <div className="h-0.5 w-4 bg-current"></div>
                        <div className="h-1.5 w-6 rounded bg-current"></div>
                    </div>
                    <div className="flex items-center gap-1">
                        <div className="h-0.5 w-4 bg-current"></div>
                        <div className="h-1.5 w-6 rounded bg-current"></div>
                    </div>
                </div>
            )
        }
    ];

  return (
    <div className="flex flex-col space-y-4">
      <div className="space-y-4 bg-muted p-2 rounded-3xl">
        <p className="text-sm text-muted-foreground px-4 pt-2">Choose the workflow that fits your team best.</p>

        <div className="grid gap-1">
          {structures.map((option) => (
            <div
              key={option.id}
              onClick={() => updateData({ structure: option.id })}
              className={cn(
                "relative flex cursor-pointer items-center space-x-4 rounded-3xl border-2 p-4 transition-all bg-background",
                data.structure === option.id 
                  ? "border-primary ring-1 ring-primary/20" 
                  : "border-muted"
              )}
            >
              <div className={cn(
                "flex h-12 w-12 shrink-0 items-center justify-center rounded-xl transition-colors",
                 data.structure === option.id ? "bg-background border border-border text-primary" : "bg-background border border-border text-muted-foreground"
              )}>
                {option.icon}
              </div>
              <div className="flex-1">
                <div className="flex items-center justify-between space-y-1">
                  <h3 className="font-medium">{option.title}</h3>
                  <div className="text-muted-foreground/50">{option.visual}</div>
                </div>
                <p className="text-sm text-muted-foreground">{option.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between rounded-lg">
        <div className="space-y-0.5">
            <Label className="text-base">Add starter stops</Label>
            <p className="text-sm text-muted-foreground">
                Automatically add default stops based on your route type.
            </p>
        </div>
        <Switch
            checked={data.addStarterTasks}
            onCheckedChange={(c) => updateData({ addStarterTasks: c })}
        />
      </div>
    </div>
  );
}
