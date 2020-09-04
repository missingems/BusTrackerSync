import Foundation
import CoreLocation

public struct BusStop: Identifiable, Codable {
  enum CodingKeys: String, CodingKey {
    case id = "BusStopCode"
    case roadName = "RoadName"
    case description = "Description"
    case latitude = "Latitude"
    case longitude = "Longitude"
  }
  
  public let id: String
  public let roadName: String
  public let description: String
  public let latitude: Double
  public let longitude: Double
  
  public var coordinate: CLLocationCoordinate2D {
    CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
  }
  
  public init(
    id: String,
    roadName: String,
    description: String,
    latitude: Double,
    longitude: Double
  ) {
    self.id = id
    self.roadName = roadName
    self.description = description
    self.latitude = latitude
    self.longitude = longitude
  }
}

public struct BusStopPayload: Decodable {
  public let value: [BusStop]
}
