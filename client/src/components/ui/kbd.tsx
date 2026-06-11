import { cn } from "@/lib/utils";

/**
 * Small visual chip used to render a keyboard shortcut key inside button
 * labels and tooltips. Carries `data-slot="kbd"` so the existing tooltip CSS
 * (`has-data-[slot=kbd]:pr-1.5` etc.) lays it out correctly when nested in
 * a TooltipContent.
 */
function Kbd({ className, children, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "pointer-events-none inline-flex h-5 min-w-5 select-none items-center justify-center rounded border border-border/60 bg-background/40 px-1 font-mono text-[10px] font-medium leading-none text-foreground/80 shadow-[0_1px_0_rgba(0,0,0,0.15)]",
        className,
      )}
      {...props}
    >
      {children}
    </kbd>
  );
}

export { Kbd };
