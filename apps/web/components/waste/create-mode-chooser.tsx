import React from "react";
import { Lightning, Compass, Check, CaretRight, X } from '@phosphor-icons/react';
import { Button } from "@/components/ui/button";

export type CreateMode = 'quick' | 'guided';

interface ModeCardProps extends React.PropsWithChildren {
  onClick: () => void;
}

function ModeCard({ children, onClick }: ModeCardProps) {
  return (
    <div 
      className={`basis-0 bg-background grow h-auto relative rounded-3xl shrink-0 cursor-pointer transition-all duration-200 hover:shadow-xl/5 border border-border/60`}
      onClick={onClick}
    >
      <div className="overflow-clip size-full">
        <div className="content-stretch flex flex-col gap-10 items-start p-6 relative size-full">{children}</div>
      </div>
    </div>
  );
}

type HelperProps = {
  text: string;
  text1: string;
};

function Helper({ text, text1 }: HelperProps) {
  return (
    <div className="basis-0 content-stretch flex flex-col gap-1.5 grow items-start justify-center min-h-px min-w-px relative shrink-0">
      <p className="font-semibold leading-6 relative shrink-0 text-foreground text-base text-nowrap">{text}</p>
      <p className="font-normal h-5 leading-5 relative shrink-0 text-muted-foreground text-sm w-full">{text1}</p>
    </div>
  );
}

interface CreateModeChooserProps {
  selected?: CreateMode;
  onSelect: (mode: CreateMode) => void;
  onCancel?: () => void;
  onContinue?: () => void;
  onClose?: () => void;
  /** What the chooser sets up ("route", "route scheme") — the copy is shared across flows. */
  entityLabel?: string;
}

export function CreateModeChooser({ selected, onSelect, onCancel, onContinue, onClose, entityLabel = "route" }: CreateModeChooserProps) {
  return (
    <div className="bg-muted relative rounded-3xl size-full" data-name="Card">
      <div className="size-full">
        <div className="content-stretch flex flex-col gap-4 items-start overflow-clip pb-4 pt-6 px-4 relative size-full">
          <div className="content-stretch flex gap-1 items-start px-0 py-2 relative shrink-0 w-full">
            <ModeCard onClick={() => onSelect('quick')}>
              <div className="content-stretch flex items-center p-3 relative rounded-xl shrink-0">
                <div aria-hidden="true" className="absolute border border-border border-solid inset-0 pointer-events-none rounded-xl" />
                <Lightning className="size-6 text-muted-foreground" />
              </div>
              <div className="content-stretch flex flex-col items-start relative shrink-0 w-full">
                <div className="content-stretch flex items-center relative shrink-0 w-full" data-name="Card / Header">
                  <div className="basis-0 content-stretch flex grow items-start min-h-px min-w-px relative shrink-0">
                    <Helper text="Quick create" text1={`Create a ${entityLabel} with minimal setup`} />
                  </div>
                </div>
              </div>
              
              {selected === 'quick' ? (
                 <div className="absolute bg-success right-6 rounded-3xl size-6 top-6" data-name="Checkbox">
                   <div className="overflow-clip relative rounded-[inherit] size-full">
                     <div className="absolute left-1/2 size-4 top-1/2 translate-x-[-50%] translate-y-[-50%]" data-name="Icon / Check">
                       <Check className="size-4 text-primary-foreground" />
                     </div>
                   </div>
                   <div aria-hidden="true" className="absolute border border-success border-solid inset-0 pointer-events-none rounded-3xl" />
                 </div>
              ) : (
                <div className="absolute bg-background right-6 rounded-3xl size-6 top-6" data-name="Checkbox">
                  <div aria-hidden="true" className="absolute border border-border border-solid inset-0 pointer-events-none rounded-3xl" />
                </div>
              )}
            </ModeCard>

            <ModeCard onClick={() => onSelect('guided')}>
              <div className="content-stretch flex items-center p-3 relative rounded-[16px] shrink-0">
                <div aria-hidden="true" className="absolute border border-border border-solid inset-0 pointer-events-none rounded-[16px]" />
                <Compass className="size-6 text-muted-foreground" />
              </div>
              <div className="content-stretch flex flex-col items-start relative shrink-0 w-full">
                <div className="content-stretch flex items-center relative shrink-0 w-full" data-name="Card / Header">
                  <div className="basis-0 content-stretch flex grow items-start min-h-px min-w-px relative shrink-0">
                    <Helper text="Guided Setup" text1="Define service, ownership, and execution" />
                  </div>
                </div>
              </div>

               {selected === 'guided' ? (
                 <div className="absolute bg-success right-6 rounded-3xl size-6 top-6" data-name="Checkbox">
                   <div className="overflow-clip relative rounded-[inherit] size-full">
                     <div className="absolute left-1/2 size-4 top-1/2 translate-x-[-50%] translate-y-[-50%]" data-name="Icon / Check">
                       <Check className="size-4 text-primary-foreground" />
                     </div>
                   </div>
                   <div aria-hidden="true" className="absolute border border-success border-solid inset-0 pointer-events-none rounded-3xl" />
                 </div>
              ) : (
                <div className="absolute bg-background right-6 rounded-3xl size-6 top-6" data-name="Checkbox">
                  <div aria-hidden="true" className="absolute border border-border border-solid inset-0 pointer-events-none rounded-3xl" />
                </div>
              )}
            </ModeCard>
          </div>

          <div className="content-stretch flex items-start justify-between relative shrink-0 w-full mt-auto" data-name="Card / Footer">
            <Button
              type="button"
              variant="ghost"
              onClick={onCancel}
              className="h-10 px-4 rounded-xl"
            >
              Cancel
            </Button>

            <Button
              type="button"
              onClick={onContinue}
              className="h-10 px-4 rounded-xl gap-2"
            >
              <span className="text-sm font-medium">Continue</span>
              <CaretRight className="size-4" />
            </Button>
          </div>

          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="absolute right-4 top-3 opacity-70 hover:opacity-100 rounded-xl"
          >
            <X className="size-4 text-muted-foreground" />
          </Button>

        </div>
      </div>
    </div>
  );
}
