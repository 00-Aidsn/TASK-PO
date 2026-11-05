/**
 * The Mad Mex sample purchase order (MorCo Fresh VIC -> Waurn Ponds, order 782296), used to check that
 * the email/CSV/PDF reproduce the required format exactly.
 */
const rows = [
  // [PurchaseItemID, code, description, cases, caseQty, caseCost]
  [1, 'MM10000', 'Avocado (10kg)', 2, 10, 61.0],
  [2, 'MM10002', 'Capsicum Green (1kg)', 2, 1, 4.5],
  [3, 'MM10049', 'Carrot 10mm Diced ( 1Kg )', 1, 1, 5.1],
  [4, 'MM10004', 'Chilli Jalapeno Fresh (1kg)', 1, 1, 11.75],
  [5, 'MM10027', 'Coriander Loose Leaf (1kg)', 1, 1, 18.5],
  [6, 'MM10047', 'Lettuce Shredded (2.5kg)', 8, 2.5, 14.5],
  [7, 'MM10008', 'Lime (1kg)', 1, 1, 9.8],
  [8, 'MM10012', 'Mushroom Button (1kg)', 1, 1, 10.5],
  [9, 'MM10014', 'Onions Brown Whole (1Kg)', 20, 1, 1.6],
  [10, 'MM10050', 'Potato 10mm Diced (1Kg)', 1, 1, 7.5],
  [11, 'MM10016', 'Rice Sunrice Brown Med Grain (Ctn 3x5kg)', 1, 15, 32.5],
  [12, 'MM10018', 'Tomatoes Roma Whole (10kg)', 2, 10, 47.0],
  [13, 'MM10026', 'Zucchini (1kg)', 2, 1, 2.8],
  [14, 'MM10043', 'Capsicum Red (1kg)', 2, 1, 4.9],
];

export function morcoSample() {
  const all = new Map();
  const items = rows.map(([id, code, name, cases, caseQty, caseCost]) => {
    const psid = 1000 + id;
    all.set(psid, { productSupplierId: psid, productId: 2000 + id, code, name, caseQty, caseCost, unitCost: caseCost / caseQty, uomSizeTypeId: null });
    return { PurchaseItemID: id, ProductSupplierID: psid, ProductID: 2000 + id, Cases: cases, Units: 0, CaseQty: caseQty, TotalUnits: cases * caseQty };
  });
  // Shuffle so the test proves lines come out in PO line order
  items.reverse();
  return {
    po: {
      PurchaseOrderID: 782296,
      Created: '2026-11-04T23:19:57.000Z', // 10:19:57 AM in Victoria (AEDT)
      DeliveryDate: '2026-11-07T00:00:00.000Z',
      Comments: '',
      Tax: 0,
    },
    items,
    supplier: { name: 'MorCo Fresh VIC', contact: '', addressLines: [], state: 'VIC', postCode: 0 },
    venueName: 'Waurn Ponds',
    shipTo: 'Shop T980B, 173-179 Colac Road, Waurn Ponds Extension, Grovedale, VIC, 3216',
    accountNo: 'MADMEXWAUR',
    catalogue: { all },
    timeZone: 'Australia/Melbourne',
  };
}

// The required body, as supplied (with the empty UOM cell kept so the columns line up).
export const MORCO_TEXT = `Purchase Order

Order No:\t782296
Ordered:\t5/11/2026 10:19:57 AM
Required:\t7/11/2026 12:00:00 AM
Contact:\t
Venue:\tWaurn Ponds
Account No:\tMADMEXWAUR

________________________________________________________________________________________________________________________
Supplier:\tShip To:
MorCo Fresh VIC\t
Shop T980B, 173-179 Colac Road, Waurn Ponds Extension, Grovedale, VIC, 3216
VIC\t
Comments:\t
________________________________________________________________________________________________________________________
Supplier Code\t| Product Description\t| Cases\t| Units\t| Total\t| UOM\t| Case Cost\t| Unit Cost\t| Total Cost
MM10000\t| Avocado (10kg)\t| 2\t| 0\t| 20\t| \t| $61.00\t| $6.10\t| $122.00
MM10002\t| Capsicum Green (1kg)\t| 2\t| 0\t| 2\t| \t| $4.50\t| $4.50\t| $9.00
MM10049\t| Carrot 10mm Diced ( 1Kg )\t| 1\t| 0\t| 1\t| \t| $5.10\t| $5.10\t| $5.10
MM10004\t| Chilli Jalapeno Fresh (1kg)\t| 1\t| 0\t| 1\t| \t| $11.75\t| $11.75\t| $11.75
MM10027\t| Coriander Loose Leaf (1kg)\t| 1\t| 0\t| 1\t| \t| $18.50\t| $18.50\t| $18.50
MM10047\t| Lettuce Shredded (2.5kg)\t| 8\t| 0\t| 20\t| \t| $14.50\t| $5.80\t| $116.00
MM10008\t| Lime (1kg)\t| 1\t| 0\t| 1\t| \t| $9.80\t| $9.80\t| $9.80
MM10012\t| Mushroom Button (1kg)\t| 1\t| 0\t| 1\t| \t| $10.50\t| $10.50\t| $10.50
MM10014\t| Onions Brown Whole (1Kg)\t| 20\t| 0\t| 20\t| \t| $1.60\t| $1.60\t| $32.00
MM10050\t| Potato 10mm Diced (1Kg)\t| 1\t| 0\t| 1\t| \t| $7.50\t| $7.50\t| $7.50
MM10016\t| Rice Sunrice Brown Med Grain (Ctn 3x5kg)\t| 1\t| 0\t| 15\t| \t| $32.50\t| $2.17\t| $32.50
MM10018\t| Tomatoes Roma Whole (10kg)\t| 2\t| 0\t| 20\t| \t| $47.00\t| $4.70\t| $94.00
MM10026\t| Zucchini (1kg)\t| 2\t| 0\t| 2\t| \t| $2.80\t| $2.80\t| $5.60
MM10043\t| Capsicum Red (1kg)\t| 2\t| 0\t| 2\t| \t| $4.90\t| $4.90\t| $9.80
________________________________________________________________________________________________________________________
SubTotal\t$484.05
Tax\t$0.00
TOTAL\t$484.05
________________________________________________________________________________________________________________________`;
