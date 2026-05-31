/**
 * Shopee order scraping — shared types.
 *
 * Two shapes:
 *   - OrderSummary: one row from the order LIST page (?type=completed).
 *   - OrderDetail:  the full order DETAIL page (/portal/sale/order/<id>).
 */

/** A single product line inside an order. */
export type OrderProduct = {
  /** Row number shown in the product list ("1", "2", ...). */
  index?: string
  name: string
  /** Variation / SKU text under the product name, e.g. "Warna: Hitam, M". */
  variation?: string
  /** Seller SKU / product code, if present. */
  code?: string
  /** Product thumbnail URL, if present. */
  imageUrl?: string
  /** Unit price text, e.g. "Rp150.400". */
  price?: string
  /** Quantity text, e.g. "1". */
  qty?: string
  /** Line subtotal text, e.g. "Rp150.400". */
  subtotal?: string
}

/** A single line in the seller-income payment breakdown. */
export type PaymentLine = {
  label: string
  amount: string
}

/** One row from the order LIST page. */
export type OrderSummary = {
  /** Numeric path id from the detail link, e.g. "229491008230333". */
  pathId: string
  /** Human order serial number, e.g. "260410E995X0WW". */
  orderSn?: string
  /** Absolute detail-page URL. */
  detailUrl: string
  buyerName?: string
  productName?: string
  variation?: string
  qty?: string
  totalPrice?: string
  status?: string
  paymentMethod?: string
  fulfilmentChannel?: string
}

/** The full order DETAIL page. */
export type OrderDetail = {
  pathId: string
  orderSn?: string
  detailUrl: string
  status?: string
  statusDescription?: string
  shippingAddress?: {
    /** Masked buyer contact line (name + masked phone). */
    buyerContact?: string
    /** Masked shipping address. */
    address?: string
  }
  shipping?: {
    packageLabel?: string
    carrier?: string
    actualCarrier?: string
    trackingNumber?: string
  }
  products: OrderProduct[]
  /** Seller-income breakdown lines (sub-totals, fees, etc.). */
  paymentBreakdown: PaymentLine[]
  /** "Total Penghasilan" line, if found. */
  total?: PaymentLine
  /** When this detail was scraped (epoch ms). */
  scrapedAt: number
}

export type ScrapeOrdersOptions = {
  /** Order tab to scrape. Defaults to 'completed'. */
  orderType?: string
  /** Cap how many orders to scrape (for testing). 0 / undefined = all. */
  limit?: number
  /**
   * Cap how many index pages (40 orders/page) to fetch. 0 / undefined = all
   * pages. E.g. 2 → only the first 2 pages (≤80 orders). Applied BEFORE
   * `limit`.
   */
  maxPages?: number
  /** Output directory for the per-order JSON files. Defaults to `result/`. */
  outDir?: string
  /** Delay (ms) between visiting each order detail, to be gentle. Default 0. */
  perOrderDelayMs?: number
  /**
   * How many order-detail pages to scrape in parallel (tabs in the same
   * authenticated context). Defaults to 4. Higher = faster but heavier.
   */
  concurrency?: number
  /**
   * Abort image/media/font requests to speed up page loads. Defaults to true.
   * Data extraction only needs the DOM, so this is safe and a big speed win.
   */
  blockResources?: boolean
  log?: (msg: string) => void
}

export type ScrapeOrdersResult = {
  orderType: string
  /** Total count Shopee reports on the list page, if read. */
  reportedCount?: number
  /** Summaries collected from the list page. */
  summaries: OrderSummary[]
  /** Full details successfully scraped. */
  details: OrderDetail[]
  /** Absolute path to the output directory. */
  outDir: string
}
