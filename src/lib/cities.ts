// Approximate city centres used for distance. Users pick a city; we never ask for exact location.
export const CITIES: { name: string; region: string; lat: number; lon: number }[] = [
  { name: "New Delhi", region: "Delhi", lat: 28.61, lon: 77.21 },
  { name: "Gurugram", region: "Haryana", lat: 28.46, lon: 77.03 },
  { name: "Noida", region: "Uttar Pradesh", lat: 28.54, lon: 77.39 },
  { name: "Mumbai", region: "Maharashtra", lat: 19.08, lon: 72.88 },
  { name: "Pune", region: "Maharashtra", lat: 18.52, lon: 73.86 },
  { name: "Bengaluru", region: "Karnataka", lat: 12.97, lon: 77.59 },
  { name: "Hyderabad", region: "Telangana", lat: 17.39, lon: 78.49 },
  { name: "Chennai", region: "Tamil Nadu", lat: 13.08, lon: 80.27 },
  { name: "Kolkata", region: "West Bengal", lat: 22.57, lon: 88.36 },
  { name: "Ahmedabad", region: "Gujarat", lat: 23.02, lon: 72.57 },
  { name: "Jaipur", region: "Rajasthan", lat: 26.91, lon: 75.79 },
  { name: "Chandigarh", region: "Chandigarh", lat: 30.73, lon: 76.78 },
  { name: "Lucknow", region: "Uttar Pradesh", lat: 26.85, lon: 80.95 },
  { name: "Kochi", region: "Kerala", lat: 9.93, lon: 76.27 },
  { name: "Goa", region: "Goa", lat: 15.5, lon: 73.83 },
  { name: "Indore", region: "Madhya Pradesh", lat: 22.72, lon: 75.86 },
  { name: "Bhopal", region: "Madhya Pradesh", lat: 23.26, lon: 77.41 },
  { name: "Dehradun", region: "Uttarakhand", lat: 30.32, lon: 78.03 },
  { name: "London", region: "United Kingdom", lat: 51.51, lon: -0.13 },
  { name: "Dubai", region: "United Arab Emirates", lat: 25.2, lon: 55.27 },
  { name: "Singapore", region: "Singapore", lat: 1.35, lon: 103.82 },
  { name: "New York", region: "United States", lat: 40.71, lon: -74.01 },
  { name: "Toronto", region: "Canada", lat: 43.65, lon: -79.38 },
  { name: "Sydney", region: "Australia", lat: -33.87, lon: 151.21 },
];

export const findCity = (name: string) => CITIES.find((c) => c.name.toLowerCase() === name.trim().toLowerCase());
