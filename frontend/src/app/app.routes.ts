import { Routes } from '@angular/router';
import { DashboardComponent } from './dashboard/dashboard.component';
import { MarketplaceComponent } from './marketplace/marketplace.component';
import { RetireComponent } from './retire/retire.component';
import { AdminComponent } from './admin/admin.component';
import { CertificatesComponent } from './certificates/certificates.component';
import { adminGuard } from './core/guards/admin.guard';

export const routes: Routes = [
  { path: '', redirectTo: 'dashboard', pathMatch: 'full' },
  { path: 'dashboard', component: DashboardComponent },
  { path: 'marketplace', component: MarketplaceComponent },
  { path: 'retire', component: RetireComponent },
  { path: 'admin', component: AdminComponent, canActivate: [adminGuard] },
  { path: 'certificates/:id', component: CertificatesComponent },
];
