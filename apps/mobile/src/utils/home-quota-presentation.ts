export type HomeQuotaRow = {
  goodsId: string;
  goodsName: string;
  quantity: number;
};

type BuildHomeQuotaRowsInput = {
  taxonomyRevision?: number;
  remainingTotal: number;
  aggregateLabel: string;
  legacyRows: HomeQuotaRow[];
};

export const buildHomeQuotaRows = ({
  taxonomyRevision,
  remainingTotal,
  aggregateLabel,
  legacyRows
}: BuildHomeQuotaRowsInput): HomeQuotaRow[] => {
  if (taxonomyRevision === undefined) {
    return legacyRows;
  }

  return [
    {
      goodsId: "hierarchical-quota",
      goodsName: aggregateLabel,
      quantity: Math.max(0, Math.floor(remainingTotal))
    }
  ];
};
