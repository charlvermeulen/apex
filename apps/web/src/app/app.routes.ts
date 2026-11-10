import { Routes } from '@angular/router';
import { authGuard, canSecGuard } from './core/guards';
import { LoginComponent } from './pages/login.component';
import { CompanyPickerComponent } from './pages/company-picker.component';
import { ChangePasswordComponent } from './pages/change-password.component';
import { ShellComponent } from './pages/shell.component';
import { DashboardComponent } from './pages/dashboard.component';
import { GlCoaComponent } from './pages/gl/gl-coa.component';
import {
  SettingsComponent, CompanyTaxComponent, YearsComponent, CompaniesTabComponent,
  UsersComponent, RolesComponent, EmailComponent, LogComponent,
} from './pages/settings/settings.pages';

export const routes: Routes = [
  { path: 'login', component: LoginComponent },
  { path: 'company-picker', component: CompanyPickerComponent, canActivate: [authGuard] },
  { path: 'change-password', component: ChangePasswordComponent, canActivate: [authGuard] },
  {
    path: '', component: ShellComponent, canActivate: [authGuard],
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
      { path: 'dashboard', component: DashboardComponent },
      { path: 'gl/coa', component: GlCoaComponent, data: { mod: 'gl', sec: 'maint' }, canActivate: [canSecGuard] },
      {
        path: 'settings', component: SettingsComponent, data: { mod: 'settings' }, canActivate: [canSecGuard],
        children: [
          { path: '', pathMatch: 'full', redirectTo: 'company' },
          { path: 'company', component: CompanyTaxComponent, data: { mod: 'settings', sec: 'company' }, canActivate: [canSecGuard] },
          { path: 'years', component: YearsComponent, data: { mod: 'settings', sec: 'years' }, canActivate: [canSecGuard] },
          { path: 'companies', component: CompaniesTabComponent, data: { mod: 'settings', sec: 'companies' }, canActivate: [canSecGuard] },
          { path: 'users', component: UsersComponent, data: { mod: 'settings', sec: 'users' }, canActivate: [canSecGuard] },
          { path: 'roles', component: RolesComponent, data: { mod: 'settings', sec: 'roles' }, canActivate: [canSecGuard] },
          { path: 'email', component: EmailComponent, data: { mod: 'settings', sec: 'email' }, canActivate: [canSecGuard] },
          { path: 'log', component: LogComponent, data: { mod: 'settings', sec: 'log' }, canActivate: [canSecGuard] },
        ],
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
