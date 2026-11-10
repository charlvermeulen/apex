import { inject } from '@angular/core';
import { Router, CanActivateFn, ActivatedRouteSnapshot } from '@angular/router';
import { AuthStore } from './auth.store';
import { ToastService, deny } from './api';

export const authGuard: CanActivateFn = async () => {
  const auth = inject(AuthStore), router = inject(Router);
  if (auth.user()) return true;
  const ok = await auth.me();
  if (!ok) return router.createUrlTree(['/login']);
  if (!auth.company() && auth.companies().length) return router.createUrlTree(['/company-picker']);
  return true;
};

// canSec route guard: route.data {mod, sec} → deny toast + redirect to dashboard (legacy canSec 2541)
export const canSecGuard: CanActivateFn = (route: ActivatedRouteSnapshot) => {
  const auth = inject(AuthStore), router = inject(Router);
  const { mod, sec } = route.data as { mod: string; sec?: string };
  const ok = sec ? auth.canSec()(mod, sec) : auth.canMod()(mod);
  if (!ok) deny();
  return ok ? true : router.createUrlTree(['/dashboard']);
};
