import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { OrderBookComponent, buildLevels, OrderBookMessage } from './order-book.component';

// Re-export buildLevels for direct testing (declared inline in the module)
// We test it via the component's public signals instead.

/** Minimal WebSocket mock */
class MockWebSocket {
  static instance: MockWebSocket | null = null;
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  readyState: number = WebSocket.CONNECTING;

  constructor(public url: string) {
    MockWebSocket.instance = this;
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
  }

  /** Test helper: simulate server sending a message */
  emit(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }

  /** Test helper: simulate connection open */
  open(): void {
    this.readyState = WebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }
}

describe('OrderBookComponent', () => {
  let fixture: ComponentFixture<OrderBookComponent>;
  let component: OrderBookComponent;
  let OrigWS: typeof WebSocket;

  beforeEach(async () => {
    OrigWS = window.WebSocket;
    (window as unknown as Record<string, unknown>)['WebSocket'] =
      MockWebSocket as unknown as typeof WebSocket;
    MockWebSocket.instance = null;

    await TestBed.configureTestingModule({
      imports: [OrderBookComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(OrderBookComponent);
    component = fixture.componentInstance;
    component.wsUrl = 'ws://test/order-book';
    fixture.detectChanges();
  });

  afterEach(() => {
    (window as unknown as Record<string, unknown>)['WebSocket'] = OrigWS;
  });

  it('shows connecting state before WS opens', () => {
    expect(component.connected()).toBe(false);
    const el: HTMLElement = fixture.nativeElement;
    expect(el.textContent).toContain('Connecting');
  });

  it('shows live badge after WS connects', () => {
    MockWebSocket.instance!.open();
    fixture.detectChanges();
    expect(component.connected()).toBe(true);
    const badge: HTMLElement = fixture.nativeElement.querySelector('.ws-badge');
    expect(badge?.textContent).toContain('Live');
  });

  it('populates bids and asks from snapshot message', () => {
    MockWebSocket.instance!.open();
    const msg: OrderBookMessage = {
      type: 'snapshot',
      bids: [
        { price: 10, quantity: 5 },
        { price: 9, quantity: 3 },
      ],
      asks: [
        { price: 11, quantity: 4 },
        { price: 12, quantity: 2 },
      ],
    };
    MockWebSocket.instance!.emit(msg);
    fixture.detectChanges();

    expect(component.bids().length).toBe(2);
    expect(component.asks().length).toBe(2);
    // Bids sorted descending by price
    expect(component.bids()[0].price).toBe(10);
    expect(component.bids()[1].price).toBe(9);
    // Asks sorted ascending by price
    expect(component.asks()[0].price).toBe(11);
    expect(component.asks()[1].price).toBe(12);
  });

  it('calculates cumulative totals correctly', () => {
    MockWebSocket.instance!.open();
    MockWebSocket.instance!.emit({
      type: 'snapshot',
      bids: [
        { price: 10, quantity: 5 },
        { price: 9, quantity: 3 },
      ],
      asks: [],
    } as OrderBookMessage);
    fixture.detectChanges();

    const bids = component.bids();
    expect(bids[0].total).toBe(5);
    expect(bids[1].total).toBe(8);
  });

  it('aggregates duplicate price levels', () => {
    MockWebSocket.instance!.open();
    MockWebSocket.instance!.emit({
      type: 'snapshot',
      bids: [
        { price: 10, quantity: 3 },
        { price: 10, quantity: 2 },
      ],
      asks: [],
    } as OrderBookMessage);
    fixture.detectChanges();

    expect(component.bids().length).toBe(1);
    expect(component.bids()[0].quantity).toBe(5);
  });

  it('computes spread between best bid and best ask', () => {
    MockWebSocket.instance!.open();
    MockWebSocket.instance!.emit({
      type: 'snapshot',
      bids: [{ price: 10, quantity: 1 }],
      asks: [{ price: 11, quantity: 1 }],
    } as OrderBookMessage);
    fixture.detectChanges();

    expect(component.spread()).toBeCloseTo(1, 2);
  });

  it('renders bid rows in the DOM', () => {
    MockWebSocket.instance!.open();
    MockWebSocket.instance!.emit({
      type: 'snapshot',
      bids: [{ price: 10, quantity: 5 }],
      asks: [],
    } as OrderBookMessage);
    fixture.detectChanges();

    const rows = fixture.nativeElement.querySelectorAll('.bid-row');
    expect(rows.length).toBeGreaterThan(0);
  });

  it('renders ask rows in the DOM', () => {
    MockWebSocket.instance!.open();
    MockWebSocket.instance!.emit({
      type: 'snapshot',
      bids: [],
      asks: [{ price: 11, quantity: 4 }],
    } as OrderBookMessage);
    fixture.detectChanges();

    const rows = fixture.nativeElement.querySelectorAll('.ask-row');
    expect(rows.length).toBeGreaterThan(0);
  });

  it('ignores malformed WebSocket messages', () => {
    MockWebSocket.instance!.open();
    MockWebSocket.instance!.onmessage?.({ data: 'not-json{{' } as MessageEvent);
    fixture.detectChanges();
    expect(component.bids().length).toBe(0);
    expect(component.asks().length).toBe(0);
  });
});
