import { Component } from '@angular/core';
import { AdminVerifiersComponent } from './admin-verifiers.component';

@Component({
  selector: 'app-admin',
  standalone: true,
  imports: [AdminVerifiersComponent],
  template: `
    <main class="admin-panel">
      <h1>Admin Panel</h1>
      <app-admin-verifiers />
    </main>
  `,
  styles: [`.admin-panel { padding: 2rem; }`],
})
export class AdminComponent {}
