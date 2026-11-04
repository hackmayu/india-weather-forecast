// Approximate city-centre coordinates (degrees, 2 decimals) for quick selection. The forecast itself
// is a 0.25 deg (~28 km) grid, so a few km of error here changes nothing; each city maps to its
// nearest grid cell. All lie inside the supported domain (6-38 N, 66-100 E).
export interface City { name: string; lat: number; lon: number }
export const CITIES: City[] = [
  { name: "Agra", lat: 27.18, lon: 78.01 }, { name: "Ahmedabad", lat: 23.02, lon: 72.57 }, { name: "Amritsar", lat: 31.63, lon: 74.87 },
  { name: "Bengaluru", lat: 12.97, lon: 77.59 }, { name: "Bhopal", lat: 23.26, lon: 77.41 }, { name: "Bhubaneswar", lat: 20.30, lon: 85.82 },
  { name: "Chandigarh", lat: 30.73, lon: 76.78 }, { name: "Chennai", lat: 13.08, lon: 80.27 }, { name: "Coimbatore", lat: 11.02, lon: 76.96 },
  { name: "Dehradun", lat: 30.32, lon: 78.03 }, { name: "Delhi", lat: 28.61, lon: 77.21 }, { name: "Guwahati", lat: 26.14, lon: 91.74 },
  { name: "Hyderabad", lat: 17.39, lon: 78.49 }, { name: "Imphal", lat: 24.82, lon: 93.94 }, { name: "Indore", lat: 22.72, lon: 75.86 },
  { name: "Jaipur", lat: 26.91, lon: 75.79 }, { name: "Jodhpur", lat: 26.24, lon: 73.02 }, { name: "Kanpur", lat: 26.45, lon: 80.35 },
  { name: "Kochi", lat: 9.93, lon: 76.27 }, { name: "Kolkata", lat: 22.57, lon: 88.36 }, { name: "Leh", lat: 34.15, lon: 77.58 },
  { name: "Lucknow", lat: 26.85, lon: 80.95 }, { name: "Madurai", lat: 9.92, lon: 78.12 }, { name: "Mangaluru", lat: 12.91, lon: 74.86 },
  { name: "Mumbai", lat: 19.08, lon: 72.88 }, { name: "Nagpur", lat: 21.15, lon: 79.09 }, { name: "Panaji", lat: 15.50, lon: 73.83 },
  { name: "Patna", lat: 25.59, lon: 85.14 }, { name: "Port Blair", lat: 11.62, lon: 92.73 }, { name: "Prayagraj", lat: 25.44, lon: 81.85 },
  { name: "Pune", lat: 18.52, lon: 73.86 }, { name: "Raipur", lat: 21.25, lon: 81.63 }, { name: "Ranchi", lat: 23.34, lon: 85.31 },
  { name: "Shillong", lat: 25.57, lon: 91.88 }, { name: "Shimla", lat: 31.10, lon: 77.17 }, { name: "Srinagar", lat: 34.08, lon: 74.80 },
  { name: "Surat", lat: 21.17, lon: 72.83 }, { name: "Thiruvananthapuram", lat: 8.52, lon: 76.94 }, { name: "Udaipur", lat: 24.58, lon: 73.71 },
  { name: "Vadodara", lat: 22.31, lon: 73.18 }, { name: "Varanasi", lat: 25.32, lon: 83.01 }, { name: "Visakhapatnam", lat: 17.69, lon: 83.22 },
];
export const findCity = (q: string): City | undefined => CITIES.find((c) => c.name.toLowerCase() === q.trim().toLowerCase());
