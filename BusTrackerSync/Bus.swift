import CoreLocation
import Foundation

public struct Bus: Identifiable {
  public let estimatedTimeArrival: Date?
  public let passengerFrequency: PassengerFrequency?
  public let accessbilityFeatures: AccessbilityFeatures?
  public let vehicleType: VehicleType?
  public let id: Date
  public let destinationCode: String
  
  public var coordinate: CLLocationCoordinate2D {
    CLLocationCoordinate2D(
      latitude: Double(latitude) ?? 0,
      longitude: Double(longitude) ?? 0
    )
  }
  
  private let latitude: String
  private let longitude: String
  
  private let dateFormatter: DateFormatter = {
    let dateFormatter = DateFormatter()
    dateFormatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ssZ"
    return dateFormatter
  }()
}

extension Bus: Equatable {
  public static func == (lhs: Self, rhs: Self) -> Bool {
    return lhs.id == rhs.id
  }
}

extension Bus: Codable {
  enum CodingKeys: String, CodingKey {
    case estimatedTimeArrival = "EstimatedArrival"
    case latitude = "Latitude"
    case longitude = "Longitude"
    case passengerFrequency = "Load"
    case accessbilityFeatures = "Feature"
    case vehicleType = "Type"
    case destinationCode = "DestinationCode"
  }
  
  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    if let estimatedTimeArrivalString = try? container.decode(String.self, forKey: .estimatedTimeArrival) {
      estimatedTimeArrival = dateFormatter.date(from: estimatedTimeArrivalString)
    } else {
      estimatedTimeArrival = nil
    }
    
    passengerFrequency = try? container.decode(PassengerFrequency.self, forKey: .passengerFrequency)
    accessbilityFeatures = try? container.decode(AccessbilityFeatures.self, forKey: .accessbilityFeatures)
    vehicleType = try? container.decode(VehicleType.self, forKey: .vehicleType)
    latitude = try container.decode(String.self, forKey: .latitude)
    longitude = try container.decode(String.self, forKey: .longitude)
    destinationCode = try container.decode(String.self, forKey: .destinationCode)
    id = estimatedTimeArrival ?? Date()
  }
  
  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    
    if let date = estimatedTimeArrival {
      try container.encode(dateFormatter.string(from: date), forKey: .estimatedTimeArrival)
    }
    
    try container.encode(latitude, forKey: .latitude)
    try container.encode(longitude, forKey: .longitude)
    try container.encode(passengerFrequency, forKey: .passengerFrequency)
    try container.encode(accessbilityFeatures, forKey: .accessbilityFeatures)
    try container.encode(vehicleType, forKey: .vehicleType)
    try container.encode(destinationCode, forKey: .destinationCode)
  }
}

public extension Bus {
  enum PassengerFrequency: String, Codable, Equatable {
    case seatsAvailable = "SEA"
    case standingAvailable = "SDA"
    case standingLimited = "LSD"
  }
}

public extension Bus {
  enum VehicleType: String, Codable, Equatable {
    case singleDeck = "SD"
    case doubleDeck = "DD"
    case bendy = "BD"
  }
}

public extension Bus {
  enum AccessbilityFeatures: String, Codable, Equatable {
    case wheelChair = "WAB"
    case empty
    case blank
  }
}
