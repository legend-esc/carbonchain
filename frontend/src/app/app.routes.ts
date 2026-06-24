import { Routes } from '@angular/router';
import { DashboardComponent } from './dashboard/dashboard.component';
import { MarketplaceComponent } from './marketplace/marketplace.component';
import { RetireComponent } from './retire/retire.component';
import { CreditDetailComponent } from './credits/credit-detail.component';
import { ProjectDetailComponent } from './projects/project-detail.component';
import { ConnectWalletComponent } from './core/components/connect-wallet.component';
import { AdminVerifiersComponent } from './admin/admin-verifiers.component';
import { authGuard } from './core/guards/auth.guard';
import { adminGuard } from './core/guards/admin.guard';

export const routes: Routes = [
  { path: '', redirectTo: 'dashboard', pathMatch: 'full' },
  { path: 'connect-wallet', component: ConnectWalletComponent },
  { path: 'dashboard', component: DashboardComponent, canActivate: [authGuard] },
  { path: 'marketplace', component: MarketplaceComponent, canActivate: [authGuard] },
  { path: 'retire', component: RetireComponent, canActivate: [authGuard] },
  { path: 'credits/:id', component: CreditDetailComponent, canActivate: [authGuard] },
  { path: 'projects/:id', component: ProjectDetailComponent, canActivate: [authGuard] },
  { path: 'admin', component: AdminVerifiersComponent, canActivate: [authGuard, adminGuard] },
];
