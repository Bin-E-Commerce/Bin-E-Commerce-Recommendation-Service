// File này định nghĩa contract kết quả analytics impact dùng trong application layer.
// Nó không biết request HTTP, SQL hay cách controller serialize response.

export type ProductImpactMetric = {
  views: number;
  sales: number;
  daysWithData: number;
  averageViews: number;
  averageSales: number;
};

export type ProductImpactDaily = {
  date: string;
  views: number;
  sales: number;
  hasData: boolean;
};

export type ProductImpactItem = {
  key: string;
  productId: string;
  before: ProductImpactMetric;
  after: ProductImpactMetric;
  daily: ProductImpactDaily[];
};

export type ProductImpactResponse = {
  items: ProductImpactItem[];
};
