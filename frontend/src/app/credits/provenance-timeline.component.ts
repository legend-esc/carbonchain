import { Component, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ProvenanceEvent } from '../core/services/api.service';

@Component({
  selector: 'app-provenance-timeline',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="timeline">
      @for (event of events(); track $index) {
        <div class="timeline__entry">
          <div class="timeline__dot" [class]="'dot--' + event.action.toLowerCase()"></div>
          <div class="timeline__content">
            <div class="timeline__header">
              <span class="timeline__action" [class]="'action--' + event.action.toLowerCase()">
                {{ formatAction(event.action) }}
              </span>
              <span class="timeline__date">{{ event.timestamp * 1000 | date: 'medium' }}</span>
            </div>
            <div class="timeline__actor mono">{{ event.actor }}</div>
            @if (event.detail) {
              <div class="timeline__detail">{{ event.detail }}</div>
            }
            @if (event.tx_hash) {
              <div class="timeline__tx mono">tx: {{ event.tx_hash | slice: 0 : 24 }}…</div>
            }
          </div>
        </div>
      }
    </div>
  `,
  styles: [`
    .timeline {
      position: relative;
      padding-left: 2rem;
    }
    .timeline::before {
      content: '';
      position: absolute;
      left: 0.5rem;
      top: 0;
      bottom: 0;
      width: 2px;
      background: #e0e0e0;
    }
    .timeline__entry {
      position: relative;
      padding-bottom: 1.25rem;
    }
    .timeline__dot {
      position: absolute;
      left: -1.5rem;
      top: 0.25rem;
      width: 12px;
      height: 12px;
      border-radius: 50%;
      border: 2px solid #ccc;
      background: #fff;
      z-index: 1;
    }
    .dot--issued { border-color: #4caf50; background: #e8f5e9; }
    .dot--split { border-color: #ff9800; background: #fff3e0; }
    .dot--transferred { border-color: #2196f3; background: #e3f2fd; }
    .dot--retired { border-color: #9c27b0; background: #f3e5f5; }
    .dot--approved { border-color: #4caf50; background: #e8f5e9; }
    .dot--submitted { border-color: #607d8b; background: #eceff1; }
    .dot--flagged { border-color: #f44336; background: #ffebee; }
    .timeline__content {
      background: #fafafa;
      border: 1px solid #eee;
      border-radius: 6px;
      padding: 0.6rem 0.9rem;
    }
    .timeline__header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 0.25rem;
    }
    .timeline__action {
      font-weight: 600;
      font-size: 0.85rem;
      padding: 0.1rem 0.4rem;
      border-radius: 3px;
    }
    .action--issued { color: #2e7d32; }
    .action--split { color: #e65100; }
    .action--transferred { color: #1565c0; }
    .action--retired { color: #6a1b9a; }
    .action--approved { color: #2e7d32; }
    .action--submitted { color: #37474f; }
    .action--flagged { color: #c62828; }
    .timeline__date { font-size: 0.78rem; color: #888; }
    .timeline__actor { font-size: 0.8rem; color: #555; word-break: break-all; }
    .timeline__detail { font-size: 0.82rem; color: #444; margin-top: 0.2rem; }
    .timeline__tx { font-size: 0.75rem; color: #999; margin-top: 0.15rem; }
    .mono { font-family: monospace; }
  `],
})
export class ProvenanceTimelineComponent {
  readonly events = input<ProvenanceEvent[]>([]);

  formatAction(action: string): string {
    switch (action.toLowerCase()) {
      case 'issued': return 'Issued';
      case 'split': return 'Split';
      case 'transferred': return 'Transferred';
      case 'retired': return 'Retired';
      case 'approved': return 'Approved';
      case 'submitted': return 'Submitted';
      case 'disputed': return 'Disputed';
      case 'resolved': return 'Resolved';
      case 'expired': return 'Expired';
      case 'flagged': return 'Flagged';
      default: return action;
    }
  }
}
