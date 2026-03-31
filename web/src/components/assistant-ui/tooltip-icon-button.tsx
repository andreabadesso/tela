import { type ComponentPropsWithRef, forwardRef } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type TooltipIconButtonProps = ComponentPropsWithRef<typeof Button> & {
  tooltip: string;
  side?: "top" | "bottom" | "left" | "right";
};

export const TooltipIconButton = forwardRef<
  HTMLButtonElement,
  TooltipIconButtonProps
>(({ children, tooltip, className, ...rest }, ref) => {
  return (
    <Button
      variant="ghost"
      size="icon"
      title={tooltip}
      {...rest}
      className={cn("aui-button-icon size-6 p-1", className)}
      ref={ref}
    >
      {children}
      <span className="sr-only">{tooltip}</span>
    </Button>
  );
});

TooltipIconButton.displayName = "TooltipIconButton";
