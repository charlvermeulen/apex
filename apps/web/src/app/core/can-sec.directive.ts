import { Directive, TemplateRef, ViewContainerRef, effect, inject, input } from '@angular/core';
import { AuthStore } from '../core/auth.store';

// Structural *appCanSec="['settings','users']" — render only if the role can access
// module.section (legacy canSec/accOf, Numera.html:2539–2541). Re-evaluates when auth state changes.
@Directive({ selector: '[appCanSec]' })
export class CanSecDirective {
  appCanSec = input<[string, string] | undefined>(undefined);

  constructor() {
    const tpl = inject(TemplateRef<unknown>);
    const vcr = inject(ViewContainerRef);
    const auth = inject(AuthStore);
    effect(() => {
      const ms = this.appCanSec();
      vcr.clear();
      if (ms && auth.canSec()(ms[0], ms[1])) vcr.createEmbeddedView(tpl);
    });
  }
}
