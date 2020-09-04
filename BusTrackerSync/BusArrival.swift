import Foundation

public struct BusArrival: Codable, Identifiable, Equatable {
  enum CodingKeys: String, CodingKey {
    case serviceNumber = "ServiceNo"
    case `operator` = "Operator"
    case nextBus = "NextBus"
    case nextBus2 = "NextBus2"
    case nextBus3 = "NextBus3"
  }
  
  public let `operator`: Operator?
  public var id: String {
    serviceNumber
  }
  
  public lazy var busses = [nextBus, nextBus2, nextBus3].compactMap { $0 }
  
  private let serviceNumber: String
  private var nextBus: Bus?
  private var nextBus2: Bus?
  private var nextBus3: Bus?
}

public extension BusArrival {
  enum Operator: String, Codable, Equatable {
    case sbsTransit = "SBST"
    case smrtCorporation = "SMRT"
    case towerTransitSingapore = "TTS"
    case goAheadSingapore = "GAS"
  }
}

public struct BusArrivalPayload: Decodable, Equatable {
  enum CodingKeys: String, CodingKey {
    case services = "Services"
  }
  
  public let services: [BusArrival]?
}
